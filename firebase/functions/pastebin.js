const { PathFragment } = require('@dustjs/skylink');
const { html, safeHtml, stripIndent } = require('common-tags');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const db = admin.firestore();

exports.serveFile = functions.https.onRequest(async (request, response) => {
  if (request.method !== 'GET') return response.status(405)
    .send(`Only GET works here`);
  try {

    const path = PathFragment.parse(request.path);
    const match = path.matchWith('/pastebin/id/:id/:*rest');
    if (!match.ok) return response.status(404)
      .send(`BUG: Pastebin path didn't match`);
    const pasteId = match.params.get('id');
    const filePath = match.params.get('rest').join('/');
    const fileName = match.params.get('rest').slice(-1)[0];

    const wantsRaw = 'raw' in request.query;
    const wantsDownload = 'download' in request.query;
    const accept = request.get('accept');
    const acceptsHtml = accept.split(',').map(x=>x.split(';')[0]).includes('text/html');

    // Perform database lookup
    const querySnap = await db.collectionGroup(`pastebin pastes`)
      .where('id', '==', pasteId).get();
    if (querySnap.size < 1) return response.status(404)
      .send(`404: Paste not found`);
    if (querySnap.size > 1) return response.status(500)
      .send(`BUG: Paste ID is conflicting`);
    const docSnap = querySnap.docs[0];
    console.log(docSnap.data());

    // Extract the document a bit
    // TODO: handle paste root by showing all files or at least a doc listing
    if (docSnap.get('filename') !== filePath) return response.status(404)
      .send(`404: File not found in paste`);
    const [mimeType, fileData] = docSnap.get('data')
    if (!mimeType.startsWith('text/')) return response.status(500)
      .send(`BUG: paste is non-text`);

    // Actually transmit some sort of response
    if (wantsDownload) {
      response.set('Content-Type', mimeType);
      response.set('Content-Disposition', `attachment; filename="${filePath}"`);
      response.status(200).send(fileData);
    } else if (acceptsHtml && !wantsRaw) {
      const Prism = require('prismjs');

      function splitIntoLines (text) {
        return (text + (text.endsWith('\n') ? '' : '\n'))
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .slice(0, -1);
      }

      const language = docSnap.get('language') || 'plain-text';
      const fileLines = (language in Prism.languages)
        ? splitIntoLines(Prism.highlight(fileData, Prism.languages[language]))
        : splitIntoLines(fileData).map(line => safeHtml`a\n${line}`.slice(2)); // work around indent strip

      function lineStyle(idx) {
        if (idx == 41) {
          return 'background-color: rgba(250,200,0,0.3);';
        }
        return '';
      }

      response.set('Content-Type', 'text/html; charset=utf-8');
      response.status(200).send(html`
        <!doctype html>
        ${safeHtml`
          <title>Paste: ${docSnap.get('title') || docSnap.get('filename')}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        `}
        <style type="text/css">
          ${ViewPasteCss}
          ${PrismThemes.get('duotone-light')}
          @media (prefers-color-scheme: dark) {
            ${ViewPasteDarkCss}
            ${PrismThemes.get('duotone-dark')}
          }
        </style>
        ${safeHtml`
          <header>
            <h2>Paste: ${docSnap.get('title') || 'untitled'}</h2>
            <p>
              <strong>${docSnap.get('filename')}</strong>
              (<a href="${fileName}?raw">View raw</a>
              | <a href="${fileName}?download">Download</a>)
            </p>
          </header>
          <pre class="language-${language}">`}`
        +fileLines.map((line,idx) => html`<div class="line">${line}`+`\n</div>`).join('')
        +html`</pre>
        <div class="fill"></div>
        ${ViewPasteFooter}
        `);
    } else {
      response.set('Content-Type', mimeType);
      response.status(200).send(fileData);
    }

  } catch (err) {
    console.log(err.stack);
    response.status(500).send(err.message);
  }
});

const ViewPasteCss = stripIndent`
  body {
    font-family: sans-serif;
    margin: 0;
  }
  header, footer {
    margin: 0 1em;
  }
  pre {
    font-family: Consolas, Menlo, Monaco, "Andale Mono WT", "Andale Mono", "Lucida Console", "Lucida Sans Typewriter", "DejaVu Sans Mono", "Bitstream Vera Sans Mono", "Liberation Mono", "Nimbus Mono L", "Courier New", Courier, monospace;
    direction: ltr;
    tab-size: 2;
    hyphens: none;
    box-sizing: border-box;
    padding: 0 1em 0 3.5em;
    border-top: 4px solid #00aeef;
    counter-reset: line;
    white-space: pre-wrap;
    /*box-shadow: inset 0 0 10px #fff;*/
    /*box-shadow: 1px 4px 7px rgba(0,0,0,0.2);*/
    box-shadow: 1px 3px 5px 2px rgba(127,127,127,0.5);
  }
  pre .line {
    display: block;
    border-left: 1px solid rgba(127, 127, 127, 0.3);
    overflow-wrap: anywhere;
    padding-bottom: 0.5em;
    padding-left: 0.5em;
  }
  .line:first-child {
    padding-top: 1em;
  }
  .line:last-child {
    padding-bottom: 1.5em;
  }
  pre .line:before {
    counter-increment: line;
    content: counter(line);
    display: inline-block;
    flex-shrink: 0;
    text-align: right;
    padding: 0 .5em;
    margin-right: 0.5em;
    margin-left: -4em;
    width: 2.5em;
    user-select: none;
    position: absolute; /* bad! */
  }

  .token.entity {
    cursor: help;
  }

  a {
    color: #666;
    text-shadow: 1px 1px 2px rgb(0,0,255,0.4);
    text-decoration: none;
  }
  a:active, a:focus {
    color: #6f6;
  }
  a:hover {
    text-decoration: underline;
  }

  footer {
    text-align: center;
    padding: 1em 1em 4em;
  }
  h4 {
    font-weight: 400;
    color: #666;
  }
  .star-icon {
    height: 64px;
    width: 64px;
    fill: hsla(159, 17%, 49%, 0.6);
  }

  @media (min-width: 40em) {
    pre {
      border-radius: 0.4em;
      margin: 0 1em;
    }
  }
  @media (min-width: 52em) {
    body { display: flex; flex-direction: column; align-items: center; }
    header { width: 50em; }
    pre { min-width: 50em; }
  }
  @media only screen and (min-width: 100em) {
    html, body { height: 100%; }
    body { flex-direction: row; align-items: flex-start; }
    header { width: auto; flex: 20em 0; }
    pre { margin: 1em 0; flex-shrink: 1; }
    .fill { flex: 1; }
    footer { flex: 25em; align-self: stretch; margin: 0 0 0 2em;
      background-color: rgba(127,127,127,0.1);
      border-left: 1px solid rgba(127,127,127,0.2);
    }
  }
`;
const ViewPasteDarkCss = stripIndent`
  body {
    background: #000;
    color: #ddd;
  }
  a {
    color: inherit;
    text-shadow: 1px 1px 2px #00f;
  }
  a:active, a:focus {
    color: #6f6;
  }
  pre {
    border-top: 4px solid #00aeef;
  }
  h4 {
    color: #999;
  }
`;

const ViewPasteFooter = html`
  <footer>
    <h4>
      Shared using
      <a href="/" target="_blank">skychat.app</a>
      - modern IRC and more
    </h4>
    <h4>
      Syntax themes by
      <a href="https://github.com/simurai" target="_blank" title="GitHub profile">simurai</a>
      via <a href="https://github.com/PrismJS/prism-themes">PrismJS</a>
    </h4>
    <a href="https://github.com/stardustapp" target="_blank" title="A proud part of the Stardust platform">
      <svg viewBox="0 0 500 500" class="star-icon" >
        <path d="M 194.62 148.583 L 237.105 270.807 L 366.475 273.443 L 263.362 351.618 L 300.832 475.471 L 194.62 401.562 L 88.408 475.471 L 125.878 351.618 L 22.765 273.443 L 152.135 270.807 Z" transform="matrix(0.894426, -0.447216, 0.447216, 0.894426, -131.26448, 91.127755)"></path>
        <path d="M 194.62 268.243 L 208.971 309.529 L 252.672 310.42 L 217.841 336.827 L 230.498 378.664 L 194.62 353.698 L 158.742 378.664 L 171.399 336.827 L 136.568 310.42 L 180.269 309.529 Z" transform="matrix(0.125241, -0.992126, 0.992127, 0.125242, -47.915505, 226.024722)"></path>
        <path d="M 194.62 246.688 L 214.039 302.554 L 273.172 303.759 L 226.041 339.491 L 243.168 396.102 L 194.62 362.32 L 146.072 396.102 L 163.199 339.491 L 116.068 303.759 L 175.201 302.554 Z" transform="matrix(0.741254, -0.671224, 0.671224, 0.741255, 43.802714, 125.863451)"></path>
      </svg>
    </a>
  </footer>
`;

const PrismThemes = new Map([
  // https://github.com/PrismJS/prism-themes/blob/master/themes/prism-duotone-light.css
  ['duotone-light', stripIndent`
    pre {
      background: #faf8f5;
      color: #728fcb;
    }
    @media only screen and (min-width: 100em) {
      footer { background: #faf8f5; }
    }
    pre::selection, pre ::selection {
      text-shadow: none;
      background: #eae6e0;
    }

    .token.comment,
    .token.prolog,
    .token.doctype,
    .token.cdata {
      color: #b6ad9a;
    }

    .token.punctuation {
      color: #b6ad9a;
    }

    .token.namespace {
      opacity: .7;
    }

    .token.tag,
    .token.operator,
    .token.number {
      color: #063289;
    }

    .token.property,
    .token.function {
      color: #b29762;
    }

    .token.tag-id,
    .token.selector,
    .token.atrule-id {
      color: #2d2006;
    }

    pre.language-javascript,
    .token.attr-name {
      color: #896724;
    }

    pre.language-css,
    pre.language-scss,
    .token.boolean,
    .token.string,
    .token.entity,
    .token.url,
    .language-css .token.string,
    .language-scss .token.string,
    .style .token.string,
    .token.attr-value,
    .token.keyword,
    .token.control,
    .token.directive,
    .token.unit,
    .token.statement,
    .token.regex,
    .token.atrule {
      color: #728fcb;
    }

    .token.placeholder,
    .token.variable {
      color: #93abdc;
    }

    .token.deleted {
      text-decoration: line-through;
    }

    .token.inserted {
      border-bottom: 1px dotted #2d2006;
      text-decoration: none;
    }

    .token.italic {
      font-style: italic;
    }

    .token.important,
    .token.bold {
      font-weight: bold;
    }

    .token.important {
      color: #896724;
    }

    .line.highlight {
      outline: .4em solid #896724;
      outline-offset: .4em;
    }

    .line {
      border-left-color: #ece8de;
    }
    .line:before {
      color: #cdc4b1;
    }
    .line-highlight {
      background: rgba(45, 32, 6, 0.2);
      background: linear-gradient(to right, rgba(45, 32, 6, 0.1) 70%, rgba(45, 32, 6, 0));
    }
  `],

  // https://github.com/PrismJS/prism-themes/blob/master/themes/prism-duotone-dark.css
  ['duotone-dark', stripIndent`
    pre {
      background: #2a2734;
      color: #9a86fd;
    }
    @media only screen and (min-width: 100em) {
      footer { background: #2a2734; }
    }
    pre::selection, pre ::selection {
      text-shadow: none;
      background: #6a51e6;
    }

    .token.comment,
    .token.prolog,
    .token.doctype,
    .token.cdata {
      color: #6c6783;
    }

    .token.punctuation {
      color: #6c6783;
    }

    .token.namespace {
      opacity: .7;
    }

    .token.tag,
    .token.operator,
    .token.number {
      color: #e09142;
    }

    .token.property,
    .token.function {
      color: #9a86fd;
    }

    .token.tag-id,
    .token.selector,
    .token.atrule-id {
      color: #eeebff;
    }

    pre.language-javascript,
    .token.attr-name {
      color: #c4b9fe;
    }

    pre.language-css,
    pre.language-scss,
    .token.boolean,
    .token.string,
    .token.entity,
    .token.url,
    .language-css .token.string,
    .language-scss .token.string,
    .style .token.string,
    .token.attr-value,
    .token.keyword,
    .token.control,
    .token.directive,
    .token.unit,
    .token.statement,
    .token.regex,
    .token.atrule {
      color: #ffcc99;
    }

    .token.placeholder,
    .token.variable {
      color: #ffcc99;
    }

    .token.deleted {
      text-decoration: line-through;
    }

    .token.inserted {
      border-bottom: 1px dotted #eeebff;
      text-decoration: none;
    }

    .token.italic {
      font-style: italic;
    }

    .token.important,
    .token.bold {
      font-weight: bold;
    }

    .token.important {
      color: #c4b9fe;
    }

    .line.highlight {
      outline: .4em solid #8a75f5;
      outline-offset: .4em;
    }

    .line {
      border-left-color: #2c2937;
    }
    .line:before {
      color: #3c3949;
    }
    .line-highlight {
      background: rgba(224, 145, 66, 0.2);
      background: linear-gradient(to right, rgba(224, 145, 66, 0.2) 70%, rgba(224, 145, 66, 0));
    }
  `],
]);
