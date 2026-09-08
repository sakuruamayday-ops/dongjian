# sharp/libvips source and relinking information

The macOS arm64 and x64 editions of Gongchuang Enterprise Assistant V0.2.0
distribute the following npm payloads without local binary modification:

- `@img/sharp-libvips-darwin-arm64` version `1.3.2`
- `@img/sharp-libvips-darwin-x64` version `1.3.2`

Both packages declare `LGPL-3.0-or-later`. They provide dynamically loaded
shared libraries used by `sharp`; they are not statically linked into the
application executable.

## Corresponding source

The exact upstream release is `sharp-libvips` tag `v1.3.2`, peeled Git commit
`4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6`:

- Source and build recipes:
  <https://github.com/lovell/sharp-libvips/tree/v1.3.2>
- Source archive:
  <https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.3.2.tar.gz>

The bundled `versions.properties` records the exact libvips `8.18.3` and
third-party component versions used by that release. The upstream build
recipes in the tagged source record the component source locations, build
options, and checksums. The bundled `THIRD-PARTY-NOTICES.md` records the
licenses of those components.

No source or binary patch is applied by Gongchuang Enterprise Assistant. The
package bytes are resolved from the pinned npm packages above through the
committed `pnpm-lock.yaml`.

## Replacement and relinking

The application is distributed with ad-hoc macOS signing. A recipient may
unpack a local copy of the application, replace the corresponding
`libvips-cpp` dynamic library in the application resources with a compatible
modified build, and ad-hoc re-sign that local application copy with:

```sh
codesign --force --deep --sign - "/path/to/Gongchuang.app"
```

The replacement library remains governed by its applicable licenses. No
warranty is provided for a modified or relinked application.
