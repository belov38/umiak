# Third-party notices: umiak-quickstart image

Components redistributed in `ghcr.io/belov38/umiak-quickstart` under their own licenses.

## moonlight-web-stream (GPL-3.0)

- Component: static web frontend of moonlight-web-stream 3.0.1, served as the owner desktop viewer at `/desktop/<slug>/`.
- License: GNU General Public License v3.0. The full text is in the image at `/app/quickstart-assets/moonlight-web/LICENSE`.
- Source: https://github.com/MrCreativ3001/moonlight-web-stream/tree/v3.0.1
- Release tarball: https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v3.0.1/moonlight-web-x86_64-unknown-linux-gnu.tar.gz
- Tarball SHA256: a46acb1f663faaff9cd97abd9671fe049dd525bfe955e95f7b9f753cc2b99f1a (same pin as `infra/templates/linux-desktop/versions.toml`).
- Modifications: `index.html` and `admin.html` are removed; the remaining files are unmodified. A `SOURCE` note next to the license records the same facts.

## Fonts

- Inter and Funnel Display (`@fontsource-variable`), SIL Open Font License 1.1. License texts: `/app/quickstart-assets/LICENSE-Inter`, `/app/quickstart-assets/LICENSE-Funnel`.
