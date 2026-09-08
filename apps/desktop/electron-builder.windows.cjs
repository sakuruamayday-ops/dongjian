const desktopPackage = require('./package.json')

module.exports = {
  ...desktopPackage.build,
  forceCodeSigning: false,
  // Windows dependencies already ship reviewed target prebuilds. Rebuilding
  // here would ask node-gyp on macOS to cross-compile fs-ext even though the
  // Win32 session lease uses its native semaphore implementation instead.
  npmRebuild: false,
  win: {
    ...desktopPackage.build.win,
    files: [
      ...desktopPackage.build.win.files,
      '!**/node_modules/fs-ext/**',
    ],
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false,
  },
}
