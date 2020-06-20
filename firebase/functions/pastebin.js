const { PathFragment } = require('@dustjs/skylink');
const { html, safeHtml, stripIndent } = require('common-tags');
const Prism = require('prismjs');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
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

      const language = docSnap.get('language') || 'plain-text';
      const styledData = (language in Prism.languages)
        ? Prism.highlight(fileData, Prism.languages[language])
        : safeHtml(fileData);

      const fileLines = (styledData + (styledData.endsWith('\n') ? '' : '\n'))
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .slice(0, -1);

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
          <style type="text/css">
            ${ViewPasteCss}
          </style>
          <h2>Paste: ${docSnap.get('title') || 'untitled'}</h2>
          <p>
            <strong>${docSnap.get('filename')}</strong>
            (<a href="${fileName}?raw">View raw</a>
            | <a href="${fileName}?download">Download</a>)
          </p>
        `}
        <pre>`+fileLines.map((line,idx) => html`<div class="line" style="${lineStyle(idx)}">${line}`+`\n</div>`).join('')+`</pre>\n`);
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
  }
  pre {
    padding: 10px 16px 10px 4em;
    border-radius: 0.4em;
    border-top: 4px solid #00aeef;
    /*box-shadow: inset 0 0 10px #fff;*/
    background: #ddd;
    counter-reset: line;
    white-space: pre-wrap;
    background: #f5f2f0;
    box-shadow: 1px 4px 7px rgba(0,0,0,0.2);
  }
  pre .line {
    display: block;
    border-left: 1px solid #ddd;
    overflow-wrap: anywhere;
    padding-bottom: 0.3rem;
  }
  pre .line:before {
    counter-increment: line;
    content: counter(line);
    color: #888;
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

  /* https://prismjs.com/themes/prism.css */
  .token.comment,
  .token.prolog,
  .token.doctype,
  .token.cdata {
    color: slategray;
  }

  .token.punctuation {
    color: #999;
  }

  .token.namespace {
    opacity: .7;
  }

  .token.property,
  .token.tag,
  .token.boolean,
  .token.number,
  .token.constant,
  .token.symbol,
  .token.deleted {
    color: #905;
  }

  .token.selector,
  .token.attr-name,
  .token.string,
  .token.char,
  .token.builtin,
  .token.inserted {
    color: #690;
  }

  .token.operator,
  .token.entity,
  .token.url,
  .language-css .token.string,
  .style .token.string {
    color: #9a6e3a;
    /* This background color was intended by the author of this theme. */
    /*background: hsla(0, 0%, 100%, .5);*/
  }

  .token.atrule,
  .token.attr-value,
  .token.keyword {
    color: #07a;
  }

  .token.function,
  .token.class-name {
    color: #DD4A68;
  }

  .token.regex,
  .token.important,
  .token.variable {
    color: #e90;
  }

  .token.important,
  .token.bold {
    font-weight: bold;
  }
  .token.italic {
    font-style: italic;
  }

  .token.entity {
    cursor: help;
  }

  @media (prefers-color-scheme: dark) {
    body {
      background: #000;
      color: #ddd;
    }
    pre {
      background: hsl(0, 0%, 8%); /* #141414 */
      color: white;
      border-top: 4px solid #00aeef;
      box-shadow: 1px 4px 7px rgba(0,0,0,0.2);
    }

    /* https://prismjs.com/themes/prism-twilight.css */
    .token.comment,
    .token.prolog,
    .token.doctype,
    .token.cdata {
      color: hsl(0, 0%, 47%); /* #777777 */
    }

    .token.punctuation {
      opacity: .7;
    }

    .token.namespace {
      opacity: .7;
    }

    .token.tag,
    .token.boolean,
    .token.number,
    .token.deleted {
      color: hsl(14, 58%, 55%); /* #CF6A4C */
    }

    .token.keyword,
    .token.property,
    .token.selector,
    .token.constant,
    .token.symbol,
    .token.builtin {
      color: hsl(53, 89%, 79%); /* #F9EE98 */
    }

    .token.attr-name,
    .token.attr-value,
    .token.string,
    .token.char,
    .token.operator,
    .token.entity,
    .token.url,
    .language-css .token.string,
    .style .token.string,
    .token.variable,
    .token.inserted {
      color: hsl(76, 21%, 52%); /* #8F9D6A */
    }

    .token.atrule {
      color: hsl(218, 22%, 55%); /* #7587A6 */
    }

    .token.regex,
    .token.important {
      color: hsl(42, 75%, 65%); /* #E9C062 */
    }

    .token.important,
    .token.bold {
      font-weight: bold;
    }
    .token.italic {
      font-style: italic;
    }

  }
`;
