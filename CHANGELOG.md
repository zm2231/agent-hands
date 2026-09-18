# Changelog

## [0.5.0](https://github.com/zm2231/agent-hands/compare/agent-hands-v0.4.1...agent-hands-v0.5.0) (2026-09-18)


### Features

* multiplex browser extension controllers ([#19](https://github.com/zm2231/agent-hands/issues/19)) ([a66ccb9](https://github.com/zm2231/agent-hands/commit/a66ccb9837b146eb9bf2ff62784f1a016d52a7fa))


### Bug Fixes

* sync browser and server versions ([#18](https://github.com/zm2231/agent-hands/issues/18)) ([790df4a](https://github.com/zm2231/agent-hands/commit/790df4aca186bccac7e2c8a8f48531dfaba0db67))

## [0.4.1](https://github.com/zm2231/agent-hands/compare/agent-hands-v0.4.0...agent-hands-v0.4.1) (2026-09-15)


### Bug Fixes

* add browser host installer CLI ([#16](https://github.com/zm2231/agent-hands/issues/16)) ([49950d2](https://github.com/zm2231/agent-hands/commit/49950d2a6301156c50df46ab91d2c627c512ba8f))

## [0.4.0](https://github.com/zm2231/agent-hands/compare/agent-hands-v0.3.3...agent-hands-v0.4.0) (2026-09-15)


### Features

* AGENT_HANDS_SURFACES env flag for surface selection ([e5e808c](https://github.com/zm2231/agent-hands/commit/e5e808cb1c51a99cae45f3bcdc70392982cf3744))
* auto-snapshot on mutation (observe: true) ([d9e15ad](https://github.com/zm2231/agent-hands/commit/d9e15ad309594aacffaffe8e60abc915d25a1234))
* **browser:** add real Chrome extension transport with auto-detection ([#11](https://github.com/zm2231/agent-hands/issues/11)) ([dadf48f](https://github.com/zm2231/agent-hands/commit/dadf48fe0e4ce9eaac9a8e2277427a14d3c81261))
* desktop_batch - same-app declarative batching ([ee8c2bb](https://github.com/zm2231/agent-hands/commit/ee8c2bb16931a365d5345ed4382a982889bf02a7))
* initial implementation - kernel, desktop surface, browser surface ([b499dd3](https://github.com/zm2231/agent-hands/commit/b499dd373ef88decd15992091cc26d524a0c98e8))
* retained broker session with idle timeout ([764053f](https://github.com/zm2231/agent-hands/commit/764053f22bc9dc79b8bc23d84d51b50f2a2f96b8))
* trim large AX trees, save full to tmp file ([2e85a17](https://github.com/zm2231/agent-hands/commit/2e85a1769c685b284feb066290ce7388a49c908f))


### Bug Fixes

* address all review findings ([219c0ed](https://github.com/zm2231/agent-hands/commit/219c0eddf9cc998962c7bb2f348b6c7677e6ec0e))
* auto-activate CUA context, preserve session on recoverable errors ([a15738f](https://github.com/zm2231/agent-hands/commit/a15738f17a742d5b96da68fce24aaf9f6459aa68))
* auto-launch SkyComputerUseService for cursor overlay ([8d96e91](https://github.com/zm2231/agent-hands/commit/8d96e9166b5ce82b1adb7cd2b50e786ab8c5a9a7))
* AX tree value cap matches actual tree format ([ba1ef0a](https://github.com/zm2231/agent-hands/commit/ba1ef0abf599a2ebfab93aa73b53e758041263dc))
* batch mutations return status only, always cap AX values ([593c333](https://github.com/zm2231/agent-hands/commit/593c33322b5d6ea6272abe6ad0d2d74e97228a1f))
* bridge listener leak + regression tests ([c7fac3f](https://github.com/zm2231/agent-hands/commit/c7fac3f9a4aa6fab400e8b679384366ea26e6824))
* broker parity with reference implementation ([f6284f3](https://github.com/zm2231/agent-hands/commit/f6284f3790dd82299e697bb72ab3736d98d909e2))
* **broker:** reject upstream schema drift ([f2c949e](https://github.com/zm2231/agent-hands/commit/f2c949eebcd300b7633fe74efa093c3ca75336ac))
* **broker:** strip codex/auth-change so Computer Use connects on codex 0.154 ([#5](https://github.com/zm2231/agent-hands/issues/5)) ([18bb0e5](https://github.com/zm2231/agent-hands/commit/18bb0e5946c8e1fad73c2af52620ccd599d22900))
* desktop inventory parsing: tools is an object map, not an array ([af289e5](https://github.com/zm2231/agent-hands/commit/af289e579620a6a1dacb886f3799ba2b13158347))
* **desktop:** broker contract parity (metadata, activation, schema drift) ([a44c268](https://github.com/zm2231/agent-hands/commit/a44c2684ee20aaf62a422792bafb1c12866f4350))
* **desktop:** return execution metadata ([a3e21ad](https://github.com/zm2231/agent-hands/commit/a3e21adfc1649b1ad00cf36f193da77b720808ba))
* **desktop:** scope activation to broker sessions ([e158cac](https://github.com/zm2231/agent-hands/commit/e158cac29b45ad3b8bfb072f854c5202fc9efc27))
* harden browser surface inputs and abort propagation ([499c8d9](https://github.com/zm2231/agent-hands/commit/499c8d903b27425122d05acc71fc29706b604322))
* remove structuredContent from all MCP responses ([1bca68f](https://github.com/zm2231/agent-hands/commit/1bca68f8976c2b347b4544fb0ba9af2470e702d4))
* strip screenshots from batch get_app_state results ([b204be1](https://github.com/zm2231/agent-hands/commit/b204be1c50c0f7dc99705d27050aea636f24f458))

## [0.3.3](https://github.com/zm2231/agent-hands/compare/agent-hands-v0.3.2...agent-hands-v0.3.3) (2026-09-14)


### Bug Fixes

* **broker:** strip codex/auth-change so Computer Use connects on codex 0.154 ([#5](https://github.com/zm2231/agent-hands/issues/5)) ([4873acf](https://github.com/zm2231/agent-hands/commit/4873acf75d2e121aeb227586bf5646e6776e8554))

## [0.3.2](https://github.com/zm2231/agent-hands/compare/agent-hands-v0.3.1...agent-hands-v0.3.2) (2026-09-14)


### Bug Fixes

* **broker:** reject upstream schema drift ([f2c949e](https://github.com/zm2231/agent-hands/commit/f2c949eebcd300b7633fe74efa093c3ca75336ac))
* **desktop:** broker contract parity (metadata, activation, schema drift) ([0088fc5](https://github.com/zm2231/agent-hands/commit/0088fc5de83c1e716905443ee0d9683990049a96))
* **desktop:** return execution metadata ([a3e21ad](https://github.com/zm2231/agent-hands/commit/a3e21adfc1649b1ad00cf36f193da77b720808ba))
* **desktop:** scope activation to broker sessions ([e158cac](https://github.com/zm2231/agent-hands/commit/e158cac29b45ad3b8bfb072f854c5202fc9efc27))
