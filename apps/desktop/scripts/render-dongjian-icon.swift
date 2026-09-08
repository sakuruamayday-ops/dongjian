import AppKit
import CoreText

// Product-native wordmark. The checked-in OFL font keeps the glyph stable.
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fontURL = URL(fileURLWithPath: CommandLine.arguments[2])
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
let descriptors = CTFontManagerCreateFontDescriptorsFromURL(fontURL as CFURL) as? [CTFontDescriptor]
guard let descriptor = descriptors?.first else { fatalError("Bundled font is unavailable") }
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: size * 4, bitsPerPixel: 32)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()
NSColor(calibratedRed: 0.56, green: 0.10, blue: 0.10, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 44, y: 44, width: 936, height: 936), xRadius: 208, yRadius: 208).fill()
let weightedDescriptor = CTFontDescriptorCreateCopyWithVariation(descriptor, NSNumber(value: 0x77676874), 600)
let font = CTFontCreateWithFontDescriptor(weightedDescriptor, 610, nil)
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(calibratedWhite: 0.98, alpha: 1)]
let glyph = NSAttributedString(string: "洞", attributes: attributes)
let bounds = glyph.size()
glyph.draw(at: NSPoint(x: (1024 - bounds.width) / 2, y: (1024 - bounds.height) / 2 + 32))
NSGraphicsContext.restoreGraphicsState()
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("dongjian-app.png"))
