# Third-party notices

This repository contains a source overlay, custom plugins, patches, and build/install tooling. It does not vendor a Vencord checkout or an OpenAsar binary. Those projects are obtained from their upstream sources during installation.

## Vencord

- Source: https://github.com/Vendicated/Vencord
- Copyright: Vendicated and Vencord contributors
- License: GPL-3.0-or-later

The overlay under `core/src/`, the patches under `patches/`, and the custom plugins integrate with or modify Vencord. Files derived from Vencord retain their upstream copyright and SPDX notices.

## Vencord Installer

- Source: https://github.com/Vencord/Installer
- Copyright: Vendicated and Vencord contributors
- License: GPL-3.0

The OpenAsar lifecycle and loader layout follow the compatibility model used by the official Vencord installer. This repository contains an independent implementation rather than vendored installer source.

## OpenAsar

- Source: https://github.com/GooseMod/OpenAsar
- Copyright: GooseMod/OpenAsar contributors
- License: AGPL-3.0

`i` downloads the official OpenAsar nightly artifact at runtime unless `OPENASAR_URL` is explicitly overridden. No OpenAsar binary or source file is committed to this repository.

## CreArts v3

- Source: https://github.com/CreArts-Community/CreArts-Discord (archived upstream)
- Copyright: 2021 Daniel Klingel
- License: MIT, see [`../themes/LICENSE-CreArts`](../themes/LICENSE-CreArts)

`themes/crearts-repatched.css` is CreArts v3 with fixes for current Discord. Vencord Forge copies it into Vencord's themes folder when the user selects it.

## Node.js and pnpm

- Sources: https://nodejs.org, https://github.com/pnpm/pnpm
- License: MIT (Node.js also bundles third-party code under its own licenses, listed in its `LICENSE` file)

Vencord Forge downloads an official Node.js build (checksum verified) and the pnpm version Vencord pins, only when they are missing, to build Vencord. They are not part of this repository or of the Forge binaries.

## veskforge

- Source: https://github.com/Microck/veskforge
- License: MIT

Inspiration for Vencord Forge's idea; no code from it is used.

## Rust crates in the Vencord Forge binaries

Generated from `forge/Cargo.lock` by `scripts/gen-docs.py`, grouped by license.

<!-- RUST-CRATES-START -->
<details><summary><strong>Apache-2.0 OR MIT</strong> (240)</summary>

accesskit 0.21.1, accesskit_atspi_common 0.14.2, accesskit_consumer 0.31.0, accesskit_macos 0.22.2, accesskit_unix 0.17.2, accesskit_windows 0.29.2, ahash 0.8.12, android-activity 0.6.1, anyhow 1.0.104, arbitrary 1.5.0, arboard 3.7.0, arrayvec 0.7.8, as-raw-xcb-connection 1.0.1, async-broadcast 0.7.2, async-channel 2.5.0, async-executor 1.14.0, async-io 2.6.0, async-lock 3.4.2, async-process 2.5.0, async-recursion 1.2.0, async-signal 0.2.14, async-task 4.7.1, async-trait 0.1.92, atomic-waker 1.1.2, atspi 0.25.0, atspi-common 0.9.0, atspi-connection 0.9.0, atspi-proxies 0.9.0, autocfg 1.5.1, base64 0.22.1, base64 0.23.1, bit-set 0.8.0, bit-vec 0.8.0, bitflags 1.3.2, bitflags 2.13.2, block-buffer 0.10.4, blocking 1.7.0, bumpalo 3.20.3, cc 1.9.0, cfg-if 1.0.5, cgl 0.3.2, concurrent-queue 2.5.0, core-foundation 0.9.4, core-foundation-sys 0.8.7, core-graphics 0.23.2, core-graphics-types 0.1.3, cpufeatures 0.2.17, crc32fast 1.5.3, crossbeam-utils 0.8.23, crypto-common 0.1.7, data-url 0.3.2, derive_arbitrary 1.5.0, digest 0.10.7, displaydoc 0.2.7, document-features 0.2.12, downcast-rs 1.2.1, ecolor 0.33.3, eframe 0.33.3, egui 0.33.3, egui-wgpu 0.33.3, egui-winit 0.33.3, egui_glow 0.33.3, emath 0.33.3, enumflags2 0.7.12, enumflags2_derive 0.7.12, epaint 0.33.3, equivalent 1.0.3, errno 0.3.14, euclid 0.22.14, event-listener 5.4.2, event-listener-strategy 0.5.4, fastrand 2.5.0, fdeflate 0.3.7, filetime 0.2.29, find-msvc-tools 0.1.15, flate2 1.1.10, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, form_urlencoded 1.2.2, futures-core 0.3.34, futures-io 0.3.34, futures-lite 2.6.1, futures-macro 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.2.17, getrandom 0.3.4, getrandom 0.4.3, half 2.7.1, hashbrown 0.15.5, hashbrown 0.16.1, hashbrown 0.17.1, hermit-abi 0.5.3, hex 0.4.3, http 1.5.0, httparse 1.10.1, idna 1.1.0, idna_adapter 1.2.2, image 0.25.10, indexmap 2.14.2, itoa 1.0.18, jni 0.22.4, jni-macros 0.22.4, jni-sys 0.3.1, jni-sys 0.4.1, jni-sys-macros 0.4.1, jobserver 0.1.35, js-sys 0.3.106, kurbo 0.11.3, libc 0.2.191, litrs 1.0.1, lock_api 0.4.14, log 0.4.34, memmap2 0.9.12, naga 27.0.3, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, nohash-hasher 0.2.0, num-traits 0.2.19, once_cell 1.21.4, ordered-stream 0.2.0, parking 2.2.1, parking_lot 0.12.5, parking_lot_core 0.9.12, percent-encoding 2.3.2, pin-project 1.1.13, pin-project-internal 1.1.13, pin-project-lite 0.2.17, piper 0.2.5, pkg-config 0.3.34, plain 0.2.3, png 0.17.16, png 0.18.1, polling 3.11.0, portable-atomic 1.15.0, portable-atomic-util 0.2.8, proc-macro-crate 3.5.0, proc-macro2 1.0.107, profiling 1.0.18, quick-error 2.0.1, quote 1.0.47, renderdoc-sys 1.1.0, resvg 0.45.1, roxmltree 0.20.0, rustc-hash 1.1.0, rustc-hash 2.1.3, rustc_version 0.4.1, rustls-pki-types 1.15.1, rustversion 1.0.23, scoped-tls 1.0.1, scopeguard 1.2.0, semver 1.0.28, serde 1.0.229, serde_core 1.0.229, serde_derive 1.0.229, serde_json 1.0.154, serde_repr 0.1.21, serde_spanned 1.1.2, sha2 0.10.9, shlex 2.0.1, signal-hook-registry 1.4.8, simd_cesu8 1.2.0, simdutf8 0.1.5, simplecss 0.2.2, siphasher 1.0.4, smallvec 1.16.3, smol_str 0.2.2, stable_deref_trait 1.2.1, static_assertions 1.1.0, svgtypes 0.15.3, syn 2.0.119, syn 3.0.9, tar 0.4.46, tempfile 3.27.0, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, toml 1.1.8+spec-1.1.0, toml_datetime 1.1.2+spec-1.1.0, toml_edit 0.25.17+spec-1.1.0, toml_parser 1.1.5+spec-1.1.0, toml_writer 1.1.3+spec-1.1.0, ttf-parser 0.25.1, type-map 0.5.1, typenum 1.20.1, unicode-segmentation 1.13.3, unicode-width 0.2.2, ureq 3.5.0, ureq-proto 0.6.5, url 2.5.8, usvg 0.45.1, utf8-zero 0.8.1, utf8_iter 1.0.4, uuid 1.26.1, version_check 0.9.5, wasm-bindgen 0.2.129, wasm-bindgen-futures 0.4.79, wasm-bindgen-macro 0.2.129, wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129, web-sys 0.3.106, web-time 1.1.0, webbrowser 1.2.4, weezl 0.1.12, wgpu 27.0.1, wgpu-core 27.0.3, wgpu-core-deps-windows-linux-android 27.0.0, wgpu-hal 27.0.4, wgpu-types 27.0.1, windows 0.61.3, windows-collections 0.2.0, windows-core 0.61.2, windows-future 0.2.1, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.1.3, windows-link 0.2.1, windows-numerics 0.2.0, windows-result 0.3.4, windows-strings 0.4.2, windows-sys 0.52.0, windows-sys 0.59.0, windows-sys 0.61.2, windows-targets 0.52.6, windows-threading 0.1.0, windows_aarch64_gnullvm 0.52.6, windows_aarch64_msvc 0.52.6, windows_i686_gnu 0.52.6, windows_i686_gnullvm 0.52.6, windows_i686_msvc 0.52.6, windows_x86_64_gnu 0.52.6, windows_x86_64_gnullvm 0.52.6, windows_x86_64_msvc 0.52.6, x11rb 0.13.2, x11rb-protocol 0.13.2, xattr 1.6.1, zeroize 1.9.1

</details>
<details><summary><strong>MIT</strong> (91)</summary>

android-properties 0.2.2, block2 0.5.1, bytes 1.12.1, calloop 0.13.0, calloop 0.14.5, calloop-wayland-source 0.3.0, calloop-wayland-source 0.4.1, cfg_aliases 0.2.2, combine 4.6.9, crunchy 0.2.4, dispatch 0.2.0, dlib 0.5.3, endi 1.1.1, fax 0.2.7, float-cmp 0.9.0, generic-array 0.14.7, glutin-winit 0.5.0, ico 0.4.0, imagesize 0.13.0, libm 0.2.16, libredox 0.1.25, memoffset 0.9.1, objc-sys 0.3.5, objc2 0.5.3, objc2 0.6.5, objc2-app-kit 0.2.2, objc2-cloud-kit 0.2.2, objc2-contacts 0.2.2, objc2-core-data 0.2.2, objc2-core-image 0.2.2, objc2-core-location 0.2.2, objc2-encode 4.1.0, objc2-foundation 0.2.2, objc2-foundation 0.3.2, objc2-link-presentation 0.2.2, objc2-metal 0.2.2, objc2-quartz-core 0.2.2, objc2-symbols 0.2.2, objc2-ui-kit 0.2.2, objc2-uniform-type-identifiers 0.2.2, objc2-user-notifications 0.2.2, orbclient 0.3.55, pico-args 0.5.0, quick-xml 0.41.0, redox_syscall 0.4.1, redox_syscall 0.5.18, redox_syscall 0.9.5, rgb 0.8.53, simd-adler32 0.3.10, slab 0.4.12, smithay-client-toolkit 0.19.2, smithay-client-toolkit 0.20.0, smithay-clipboard 0.7.3, strict-num 0.1.1, synstructure 0.14.0, tiff 0.11.3, tokio 1.54.1, tracing 0.1.44, tracing-attributes 0.1.31, tracing-core 0.1.36, uds_windows 1.2.1, wayland-backend 0.3.17, wayland-client 0.31.15, wayland-csd-frame 0.3.0, wayland-cursor 0.31.14, wayland-protocols 0.32.13, wayland-protocols-experimental 20250721.0.1, wayland-protocols-misc 0.3.12, wayland-protocols-plasma 0.3.12, wayland-protocols-wlr 0.3.12, wayland-scanner 0.31.11, wayland-sys 0.31.11, winnow 1.0.4, winresource 0.1.34, x11-dl 2.21.0, xcursor 0.3.11, xkbcommon-dl 0.4.2, xml-rs 0.8.29, xmlwriter 0.1.0, zbus 5.19.0, zbus-lockstep 0.5.2, zbus-lockstep-macros 0.5.2, zbus_macros 5.19.0, zbus_names 4.3.5, zbus_xml 5.2.1, zcheapstr 1.1.0, zip 2.6.1, zmij 1.0.23, zvariant 5.15.1, zvariant_derive 5.15.1, zvariant_utils 4.2.0

</details>
<details><summary><strong>Unicode-3.0</strong> (18)</summary>

icu_collections 2.3.0, icu_locale_core 2.3.0, icu_normalizer 2.3.0, icu_normalizer_data 2.3.0, icu_properties 2.3.0, icu_properties_data 2.3.0, icu_provider 2.3.1, litemap 0.8.3, potential_utf 0.1.6, tinystr 0.8.4, writeable 0.6.4, yoke 0.8.3, yoke-derive 0.8.4, zerofrom 0.1.8, zerofrom-derive 0.1.8, zerotrie 0.2.5, zerovec 0.11.8, zerovec-derive 0.11.6

</details>
<details><summary><strong>Apache-2.0 OR MIT OR Zlib</strong> (15)</summary>

bytemuck 1.25.2, bytemuck_derive 1.12.1, cursor-icon 1.2.0, dispatch2 0.3.1, glow 0.16.0, miniz_oxide 0.8.9, miniz_oxide 0.9.1, objc2-app-kit 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-io-surface 0.3.2, raw-window-handle 0.6.2, xkeysym 0.2.1, zune-core 0.5.3, zune-jpeg 0.5.15

</details>
<details><summary><strong>Apache-2.0</strong> (14)</summary>

ab_glyph 0.2.32, ab_glyph_rasterizer 0.1.10, accesskit_winit 0.29.2, codespan-reporting 0.12.0, gethostname 1.1.0, gl_generator 0.14.0, glutin 0.32.3, glutin_egl_sys 0.7.1, glutin_glx_sys 0.6.1, glutin_wgl_sys 0.6.1, khronos_api 3.1.0, owned_ttf_parser 0.25.1, winit 0.30.13, zopfli 0.8.4

</details>
<details><summary><strong>Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT</strong> (7)</summary>

linux-raw-sys 0.12.1, linux-raw-sys 0.4.15, rustix 0.38.44, rustix 1.1.5, wasi 0.11.1+wasi-snapshot-preview1, wasip2 1.0.4+wasi-0.2.12, wit-bindgen 0.57.1

</details>
<details><summary><strong>MIT OR Unlicense</strong> (6)</summary>

byteorder 1.5.0, byteorder-lite 0.1.0, memchr 2.8.3, same-file 1.0.6, walkdir 2.5.0, winapi-util 0.1.11

</details>
<details><summary><strong>Zlib</strong> (4)</summary>

foldhash 0.1.5, foldhash 0.2.0, slotmap 1.1.1, zlib-rs 0.6.8

</details>
<details><summary><strong>BSD-3-Clause</strong> (3)</summary>

subtle 2.6.1, tiny-skia 0.11.4, tiny-skia-path 0.11.4

</details>
<details><summary><strong>ISC</strong> (3)</summary>

libloading 0.8.9, rustls-webpki 0.103.16, untrusted 0.9.0

</details>
<details><summary><strong>Apache-2.0 OR BSD-2-Clause OR MIT</strong> (2)</summary>

zerocopy 0.8.63, zerocopy-derive 0.8.63

</details>
<details><summary><strong>Apache-2.0 OR BSD-3-Clause</strong> (2)</summary>

moxcms 0.8.1, pxfm 0.1.30

</details>
<details><summary><strong>Apache-2.0 OR BSD-3-Clause OR MIT</strong> (2)</summary>

num_enum 0.7.6, num_enum_derive 0.7.6

</details>
<details><summary><strong>Apache-2.0 OR LGPL-2.1-or-later OR MIT</strong> (2)</summary>

r-efi 5.3.0, r-efi 6.0.0

</details>
<details><summary><strong>BSL-1.0</strong> (2)</summary>

clipboard-win 5.4.1, error-code 3.4.0

</details>
<details><summary><strong>(MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0</strong> (1)</summary>

epaint_default_fonts 0.33.3

</details>
<details><summary><strong>(MIT OR Apache-2.0) AND Unicode-3.0</strong> (1)</summary>

unicode-ident 1.0.27

</details>
<details><summary><strong>0BSD OR Apache-2.0 OR MIT</strong> (1)</summary>

adler2 2.0.1

</details>
<details><summary><strong>Apache-2.0 AND ISC</strong> (1)</summary>

ring 0.17.14

</details>
<details><summary><strong>Apache-2.0 AND MIT</strong> (1)</summary>

dpi 0.1.2

</details>
<details><summary><strong>Apache-2.0 OR ISC OR MIT</strong> (1)</summary>

rustls 0.23.46

</details>
<details><summary><strong>BSD-2-Clause</strong> (1)</summary>

arrayref 0.3.9

</details>
<details><summary><strong>CC0-1.0</strong> (1)</summary>

hexf-parse 0.2.1

</details>
<details><summary><strong>CDLA-Permissive-2.0</strong> (1)</summary>

webpki-roots 1.0.10

</details>
<!-- RUST-CRATES-END -->

## Repository license

Unless a file states otherwise, this repository is licensed under GPL-3.0-or-later. See [`../LICENSE`](../LICENSE).
