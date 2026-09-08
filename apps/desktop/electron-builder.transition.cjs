const desktopPackage = require('./package.json')

module.exports = {
  ...desktopPackage.build,
  appId: 'cn.dongjian.desktop.transition-v020',
  productName: '洞见 V0.2.0 过渡安装程序',
  artifactName: 'Dongjian-0.2.0-Transition-${arch}.${ext}',
  extraMetadata: {
    main: 'dist/macos-transition.js',
    name: '@gongchuang/macos-transition-v020',
    version: '0.2.0',
  },
  directories: {
    output: 'release-transition',
  },
  mac: {
    ...desktopPackage.build.mac,
    target: ['zip'],
  },
  publish: null,
}
