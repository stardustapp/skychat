// I copied most of this first section from a github repo
// No idea where
// Also added hex and more toggles and such since then

var char_color = '\x03';
var char_hex_color = '\x04';
var regexp_color = /(^[\d]{1,2})?(?:,([\d]{1,2}))?/;
var regexp_hex_color = /(^[0-9A-F]{6})?(?:,([0-9A-F]{6}))?/i;

var style_chars = {
  '\x02': 'bold',
  '\x11': 'monospace',
  '\x1d': 'italic',
  '\x1e': 'strikethru',
  '\x1f': 'underline',
  '\x0f': 'reset',
  '\x16': 'inverse',
  '\x07': 'bell',
};

class Style {
  constructor(style) {
    this.b = style.b;
    this.i = style.i;
    this.u = style.u;
    this.s = style.s;
    this.m = style.m;
    this.fg = style.fg;
    this.bg = style.bg;
  }
  applyColorCodes(match, base_style, formatter) {
    // color char without color code is a soft style reset
    if (match[1] === undefined && match[2] === undefined) {
      this.fg = base_style.fg;
      this.bg = base_style.bg;
    } else {
      if (match[1] !== undefined)
        this.fg = formatter(match[1]);
      if (match[2] !== undefined)
        this.bg = formatter(match[2]);
    }
  }
};

var style_fns = {};
style_fns.bold = function(style){ style.b = !style.b };
style_fns.italic = function(style){ style.i = !style.i };
style_fns.underline = function(style){ style.u = !style.u };
style_fns.strikethru = function(style){ style.s = !style.s };
style_fns.monospace = function(style){ style.m = !style.m };
style_fns.inverse = function(style){
  // TODO: if uncolored, use overall theme's inverse
  var tmp = style.fg;
  style.fg = style.bg;
  style.bg = tmp;
};
style_fns.reset = function(style, base_style){
  style.b =  base_style.b;
  style.i =  base_style.i;
  style.u =  base_style.u;
  style.s =  base_style.s;
  style.m =  base_style.m;
  style.fg = base_style.fg;
  style.bg = base_style.bg;
};
style_fns.bell = function(style){
  // TODO: report bells (lightly)
};

var colorcode_to_json = function(string, opts){
  // hmm, looks like its already converted
  if (typeof string === 'object' &&
      'lines' in string &&
      'w' in string &&
      'h' in string)
    return string;

  opts = opts || {};
  var d = colorcode_to_json.defaults;

  var base_style = {
    b:  "b" in opts ? opts.b : d.b,
    i:  "i" in opts ? opts.i : d.i,
    u:  "u" in opts ? opts.u : d.u,
    s:  "s" in opts ? opts.s : d.s,
    m:  "m" in opts ? opts.m : d.m,
    fg: "fg" in opts ? opts.fg : d.fg,
    bg: "bg" in opts ? opts.bg : d.bg
  };

  var lines_in = string.split(/\r?\n/);
  var lines_out = [];
  var w = 0, h = 0;

  for (var i=0; i<lines_in.length; i++){
    var line = lines_in[i];
    if (line.length === 0) continue; // skip blank lines
    var json_line = line_to_json(line, base_style);
    if (w < json_line.length) w = json_line.length;
    lines_out.push(json_line);
    h++;
  }

  return { w, h,
          lines: lines_out,
         };
};

colorcode_to_json.defaults = {
  b: false,
  i: false,
  u: false,
  s: false,
  m: false,
  fg: 99,
  bg: 99,
};

var line_to_json = function(line, base_style){
  var out = [];
  var pos = -1;
  var len = line.length -1;
  var char;
  var style = new Style(base_style);

  while (pos < len){
    pos++;
    char = line[pos];

    // next char is a styling char
    if (char in style_chars) {
      style_fns[style_chars[char]](style, base_style);
      continue;
    }

    if (char === char_color) {
      // next char is a color styling char, with possible color nums after
      const match = line.substr(pos+1, 5)
        .match(regexp_color);
      style.applyColorCodes(match, base_style, Number);

      pos += match[0].length;
      continue;

    } else if (char === char_hex_color) {
      // newer, hex-style color codes
      var match = line.substr(pos+1, 13)
        .match(regexp_hex_color);
      style.applyColorCodes(match, base_style, String);

      pos += match[0].length;
      continue;

    } else {
      // otherwise, next char is treated as normal content
      var data = new Style(style);
      //data.value = char;
      data.value = char.charCodeAt(0);

      out.push(data);
    }
  }
  return out;
};


const palette = [
  // user-customizable palette 0-15
  // this is the mIRC palette from the github repo i copied from
  'rgb(255,255,255)',
  'rgb(0,0,0)',
  '#4682b4', // navy, was rgb(0,0,127)
  'rgb(0,147,0)',
  'rgb(255,0,0)',
  'rgb(127,0,0)',
  'rgb(156,0,156)',
  'rgb(252,127,0)',
  'rgb(255,255,0)',
  'rgb(0,252,0)',
  'rgb(0,147,147)',
  'rgb(0,255,255)',
  'rgb(0,0,252)',
  'rgb(255,0,255)',
  'rgb(127,127,127)',
  'rgb(210,210,210)',
  // extended colors 16-98, as spec'd (aka don't edit)
  '#470000', '#472100', '#474700', '#324700',
  '#004700', '#00472c', '#004747', '#002747',
  '#000047', '#2e0047', '#470047', '#47002a',
  '#740000', '#743a00', '#747400', '#517400',
  '#007400', '#007449', '#007474', '#004074',
  '#000074', '#4b0074', '#740074', '#740045',
  '#b50000', '#b56300', '#b5b500', '#7db500',
  '#00b500', '#00b571', '#00b5b5', '#0063b5',
  '#0000b5', '#7500b5', '#b500b5', '#b5006b',
  '#ff0000', '#ff8c00', '#ffff00', '#b2ff00',
  '#00ff00', '#00ffa0', '#00ffff', '#008cff',
  '#0000ff', '#a500ff', '#ff00ff', '#ff0098',
  '#ff5959', '#ffb459', '#ffff71', '#cfff60',
  '#6fff6f', '#65ffc9', '#6dffff', '#59b4ff',
  '#5959ff', '#c459ff', '#ff66ff', '#ff59bc',
  '#ff9c9c', '#ffd39c', '#ffff9c', '#e2ff9c',
  '#9cff9c', '#9cffdb', '#9cffff', '#9cd3ff',
  '#9c9cff', '#dc9cff', '#ff9cff', '#ff94d3',
  '#000000', '#131313', '#282828', '#363636',
  '#4d4d4d', '#656565', '#818181', '#9f9f9f',
  '#bcbcbc', '#e2e2e2', '#ffffff',
];


// i actually wrote this - segments based on formatted changes and generates spans
// up to you to create html w/ it
//== supports:
// bold, italic, underline, strikethrough, monospace, foreground, background
//   parsed by thirdparty script and chunked into CSS styles
// `...`
//   parsed cross-chunk and marked type=code. can't be empty
// > ...
//   > at the beginning of the msg sets the whole message class=quote
// protocol://link...
//   split out of chunks to wrap URLs. type=link. doesn't work cross-chunk

function renderColor(color) {
  switch (color.constructor) {
    case Number: return palette[color];
    case String: return `#${color}`;
    default: throw new Error(`cant render color ${color.constructor.name}`);
  }
}

function colorize (text) {
  var segment = {text: '', idx: 0};
  var segments = [segment];
  var classes = [];
  var obj = {segments, classes};
  var unmatchedTick;
  var unmatchedTickIdx;

  var cur = {initial: true};
  colorcode_to_json(text).lines.forEach(l => {
    l.forEach(c => {
      if (cur.newline) {
        // starting a non-first line, let's reset and write a newline
        segment = {text: '\n', idx: segments.length};
        segments.push(segment);
      }

      if (cur.b != c.b || cur.i != c.i || cur.u != c.u || cur.s != c.s || cur.m != c.m || cur.fg != c.fg || cur.bg != c.bg) {
        if (cur.initial) {
          if (c.value === 62 && l.length > 3 && !classes.includes('quote')) { // >
            classes.push('quote');
            return; // don't include the >
          }
          if (c.value === 32 || c.value === 9 && !classes.includes('monospace')) { // space, tab
            classes.push('monospace');
          }
        } else {
          segment = {text: '', idx: segments.length};
          segments.push(segment);
        }
        let css = ''
        if (c.b) css += 'font-weight:bold;';
        if (c.i) css += 'font-style:italic;';
        if (c.u && c.s) css += 'text-decoration:underline line-through;';
        else {
          if (c.u) css += 'text-decoration:underline;';
          if (c.s) css += 'text-decoration:line-through;';
        }
        if (c.m) css += 'font-family:monospace;';
        if (c.fg !== 99) css += 'color:'+renderColor(c.fg)+';';
        if (c.bg !== 99) css += 'background-color:'+renderColor(c.bg)+';';
        segment.css = css;
        cur = c;
      }

      var recordText = true;

      if (c.value === 96) { // `
        if (unmatchedTick) {
          var segIdx = segments.indexOf(unmatchedTick);
          var tickIdx = unmatchedTickIdx; // unmatchedTick.text.indexOf('`');
          const isCurrent = unmatchedTick === segment;

          // split out any prefix
          if (tickIdx > 0) {
            var newSeg = JSON.parse(JSON.stringify(unmatchedTick));
            newSeg.text = newSeg.text.slice(0, tickIdx);
            segments.splice(segIdx, 0, newSeg);

            unmatchedTick.text = unmatchedTick.text.slice(tickIdx);
            segIdx++;
            tickIdx = 0;
          }

          // adopt the contents
          if (unmatchedTick.text.length > 1) {
            unmatchedTick.text = unmatchedTick.text.slice(1);
            recordText = false;

            // mark all segments between there and here
            while (segIdx < segments.length) {
              segments[segIdx].type = 'code';
              segIdx++;
            }

            // make a new non-code segment
            segment = {text: '', idx: segments.length};
            segments.push(segment);

            unmatchedTick = null;
            unmatchedTickIdx = null;
          } else {
            unmatchedTick = segment;
            unmatchedTickIdx = segment.text.length;
          }

        } else {
          unmatchedTick = segment;
          unmatchedTickIdx = segment.text.length;
        }
      }

      if (recordText) {
        segment.text += String.fromCharCode(c.value);
      }
    });

    // wipe state in case there's more lines
    cur = {initial: true, newline: true};
  });

  // Check for URLs, break into link segments
  var segCount = segments.length;
  for (var i = 0; i < segCount; i++) {
    var match;
    const seg = segments[i];
    if (match = seg.text.match(/^(.*?)\b([a-z+]+):\/\/([^ ]+)\b(.*)$/)) {
      if ((match[1].length + match[2].length) === 0) {
        continue;
      }
      if (match[1].length) {
        const preSeg = JSON.parse(JSON.stringify(segments[i]));
        preSeg.text = match[1];
        segments.splice(i, 0, preSeg);
        i++;
        segCount++;
      }
      if (match[4].length) {
        const postSeg = JSON.parse(JSON.stringify(segments[i]));
        postSeg.text = match[4];
        segments.splice(i+1, 0, postSeg);
        segCount++;
      }
      // this is pretty bad
      if (match[1].length) {
        i-=2;
      }
      seg.text = match[2] + '://' + match[3];

      const slices = seg.text.split('/');
      seg.scheme = match[2];
      seg.domain = slices[2];
      seg.origin = slices.slice(0,3).join('/');
      seg.path = (slices.length>3||slices[2]) ? '/'+slices.slice(3).join('/') : '';
      seg.type = 'link';
    }
  }

  // Number the segments for vue
  segments.forEach((seg, idx) => seg.idx = idx);

  // If there's only one segment, make sure it's not empty
  if (segments.length == 1 && !segments[0].text) {
    segments[0].text = ' ';
  }

  return obj;
}


////// nick coloring
// the algorithm is converted from irccloud android (apache 2)

const light_nick_colors = [
  "b22222", "d2691e", "ff9166", "fa8072", "ff8c00", "228b22", "808000",
  "b7b05d", "8ebd2e", "2ebd2e", "82b482", "37a467", "57c8a1", "1da199",
  "579193", "008b8b", "00bfff", "4682b4", "1e90ff", "4169e1", "6a5acd",
  "7b68ee", "9400d3", "8b008b", "ba55d3", "ff00ff", "ff1493"];
const dark_nick_colors = [
  "deb887", "ffd700", "ff9166", "fa8072", "ff8c00", "00ff00", "ffff00",
  "bdb76b", "9acd32", "32cd32", "8fbc8f", "3cb371", "66cdaa", "20b2aa",
  "40e0d0", "00ffff", "00bfff", "87ceeb", "339cff", "6495ed", "b2a9e5",
  "ff69b4", "da70d6", "ee82ee", "d68fff", "ff00ff", "ffb6c1"];
const mykey_nick_colors = [
  "bf4029", "d16e36", "dc9f3e", "79af9f", "679dc6"];

function colorForNick(nick, isDarkTheme) {
  // Normalise a bit
  const normalizedNick = nick.toLowerCase()
    // typically ` and _ are used on the end alone
    .replace(/[`_]+$/, '')
    //remove |<anything> from the end
    .replace(/\|.*$/, '');

  // Hash up the nickname
  let hash = 0;
  for (var i = 0; i < normalizedNick.length; i++) {
    hash = normalizedNick.charCodeAt(i)
            + (hash << 6) + (hash << 16) - hash;
  }

  // Look up the color
  var colors = isDarkTheme ? dark_nick_colors : light_nick_colors;
  if (orbiter.launcher.chartName === 'mykey') {
    colors = mykey_nick_colors;
  }
  return '#' + colors[Math.abs(hash % colors.length)];
}
