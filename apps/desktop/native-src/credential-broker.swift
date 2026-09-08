import Darwin
import Foundation
import Security

private let productBundleIdentifier = "cn.dongjian.desktop"
private let brokerRelativePath = "Resources/product/credentials/gongchuang-credential-broker"
private let keychainService = "cn.dongjian.desktop.credentials.v2"
private let maximumRequestBytes = 256 * 1024
private let processPathBufferBytes = 4 * 1024

private enum BrokerError: Error {
  case invalidParent
  case invalidRequest
  case keychain(OSStatus)
}

private func checkedParentApplication() throws {
  var pathBuffer = [CChar](repeating: 0, count: processPathBufferBytes)
  guard proc_pidpath(getppid(), &pathBuffer, UInt32(pathBuffer.count)) > 0 else {
    throw BrokerError.invalidParent
  }
  let executable = URL(fileURLWithPath: String(cString: pathBuffer)).resolvingSymlinksInPath()
  let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
  let application = contents.deletingLastPathComponent()
  guard application.pathExtension == "app",
        Bundle(url: application)?.bundleIdentifier == productBundleIdentifier,
        Bundle(url: application)?.executableURL?.resolvingSymlinksInPath() == executable else {
    throw BrokerError.invalidParent
  }

  let expectedBroker = contents.appendingPathComponent(brokerRelativePath).resolvingSymlinksInPath()
  let runningBroker = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  guard expectedBroker == runningBroker else { throw BrokerError.invalidParent }

  var staticCode: SecStaticCode?
  guard SecStaticCodeCreateWithPath(application as CFURL, [], &staticCode) == errSecSuccess,
        let staticCode,
        SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess else {
    throw BrokerError.invalidParent
  }
}

private func checkedRequest(_ line: String) throws -> (operation: String, reference: String, value: String?) {
  guard line.utf8.count <= maximumRequestBytes,
        let data = line.data(using: .utf8),
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let operation = object["op"] as? String,
        let reference = object["ref"] as? String,
        reference.count <= 128,
        reference.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else {
    throw BrokerError.invalidRequest
  }
  let value = object["value"] as? String
  guard operation == "read" || operation == "delete"
          || (operation == "write" && value != nil && value!.utf8.count <= maximumRequestBytes) else {
    throw BrokerError.invalidRequest
  }
  return (operation, reference, value)
}

private func baseQuery(_ reference: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: reference,
  ]
}

private func read(_ reference: String) throws -> String? {
  var query = baseQuery(reference)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { return nil }
  guard status == errSecSuccess,
        let data = result as? Data,
        let value = String(data: data, encoding: .utf8) else {
    throw BrokerError.keychain(status)
  }
  return value
}

private func write(_ reference: String, value: String) throws {
  let bytes = Data(value.utf8)
  let updateStatus = SecItemUpdate(
    baseQuery(reference) as CFDictionary,
    [kSecValueData as String: bytes] as CFDictionary
  )
  if updateStatus == errSecSuccess { return }
  guard updateStatus == errSecItemNotFound else { throw BrokerError.keychain(updateStatus) }

  var add = baseQuery(reference)
  add[kSecValueData as String] = bytes
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  let addStatus = SecItemAdd(add as CFDictionary, nil)
  guard addStatus == errSecSuccess else { throw BrokerError.keychain(addStatus) }
}

private func remove(_ reference: String) throws {
  let status = SecItemDelete(baseQuery(reference) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else {
    throw BrokerError.keychain(status)
  }
}

private func emit(_ result: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "result": result]),
        let line = String(data: data, encoding: .utf8) else {
    print("{\"ok\":false}")
    fflush(stdout)
    return
  }
  print(line)
  fflush(stdout)
}

private func reject() {
  print("{\"ok\":false}")
  fflush(stdout)
}

do {
  try checkedParentApplication()
} catch {
  reject()
  exit(77)
}

// 凭据只经过父子进程管道，不进入命令行、环境变量或日志。这个 helper 的已签名字节
// 必须跨客户端版本保持不变；否则 Keychain 会再次把它识别为一个新的应用身份。
while let line = readLine(strippingNewline: true) {
  autoreleasepool {
    do {
      let request = try checkedRequest(line)
      switch request.operation {
      case "read":
        if let value = try read(request.reference) {
          emit(["found": true, "value": value])
        } else {
          emit(["found": false])
        }
      case "write":
        try write(request.reference, value: request.value!)
        emit(["written": true])
      case "delete":
        try remove(request.reference)
        emit(["deleted": true])
      default:
        reject()
      }
    } catch {
      // 不把 OSStatus、路径或请求内容回显给调用方；Host 统一投影为可重试的凭据错误。
      reject()
    }
  }
}
