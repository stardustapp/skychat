const { PathFragment } = require('@dustjs/skylink');
const { html, safeHtml, stripIndent } = require('common-tags');

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
      const fileLines = (fileData + (fileData.endsWith('\n') ? '\n' : ''))
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .slice(0, -1);

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
        <pre>`+fileLines.map(line => safeHtml`<span>${line}`+`\n</span>`).join('')+`</pre>\n`);
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
    padding: 10px 16px 10px 3em;
    border-radius: 2px;
    border-top: 4px solid #00aeef;
    box-shadow: inset 0 0 10px #ccc;
    counter-reset: line;
    white-space: pre-wrap;
  }
  pre span {
    padding-left: -2em;
    display: inline-flex;
    border-left: 1px solid #ddd;
    width: 100%;
    overflow-wrap: anywhere;
    padding-bottom: 0.3rem;
  }
  pre span:before {
    counter-increment: line;
    content: counter(line);
    padding: 0 .5em;
    color: #888;
    display: inline-block;
    flex-shrink: 0;
    margin-right: 0.5em;
    margin-left: -3.5em;
    width: 2.5em;
    user-select: none;
  }

  @media (prefers-color-scheme: dark) {
    body {
      background: #000;
      color: #ddd;
    }
    pre {
      background: #303030;
      color: #f1f1f1;
      border-top: 4px solid #00aeef;
      box-shadow: inset 0 0 10px #000;
    }
  }
`;
