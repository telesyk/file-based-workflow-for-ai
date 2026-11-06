# Third-party code and resources

## marked (bundled)

The board renders Markdown with `marked`, bundled as `hub-template/vendor/marked.min.js` (version 12.0.2). The file keeps its original header.

- Project: https://github.com/markedjs/marked
- License: MIT
- Copyright (c) 2011-2024, Christopher Jeffrey

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Check the license text and the copyright lines of the `marked` project when you update the bundled version.

## Fonts (loaded from Google Fonts, not bundled)

The board asks Google Fonts for the fonts Public Sans and JetBrains Mono. Both are licensed under the SIL Open Font License 1.1. When the board is opened, the browser contacts `fonts.googleapis.com` and `fonts.gstatic.com`. Offline, or when the request is blocked, the board uses system fonts.

## Node.js

The scripts `serve.mjs` and `sync-manifests.mjs` use only the built-in modules of Node.js. No other package is needed.
