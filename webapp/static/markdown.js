/*
 * Tiny, dependency-free Markdown -> HTML renderer for the preview pane.
 *
 * Deliberately self-contained (no CDN / build step) so the app renders fully
 * offline inside Docker. Covers what MarkItDown emits: headings, paragraphs,
 * bold/italic/strikethrough, inline + fenced code, links, images, blockquotes,
 * ordered/unordered (nested) lists, GitHub pipe tables, horizontal rules and
 * the `<!-- page N -->` markers some converters produce.
 *
 * Everything is HTML-escaped before formatting, so converted document content
 * is rendered as text, never executed.
 */
(function (global) {
  "use strict";

  var MAX_QUOTE_DEPTH = 24;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeUrl(url) {
    // Browsers ignore leading control chars / whitespace when resolving a URL,
    // so strip them before detecting the scheme, then allow only safe schemes
    // (or scheme-less relative / anchor URLs). Blocks javascript:, vbscript:,
    // data:, etc. regardless of case or embedded control characters.
    var u = String(url).replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
    if (scheme) {
      var s = scheme[1].toLowerCase();
      if (s !== "http" && s !== "https" && s !== "mailto") return "#";
    }
    return u;
  }

  // Inline formatting for a single run of text.
  function inline(raw) {
    var codes = [];
    // Protect inline code spans with a NUL sentinel. NUL cannot appear in the
    // (NUL-stripped) source and is untouched by escapeHtml, so it never
    // collides with ordinary prose like "gate C12".
    var s = raw.replace(/`([^`]+)`/g, function (m, c) {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });

    s = escapeHtml(s);

    // Images: ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, function (m, alt, url) {
      return '<img alt="' + alt + '" src="' + safeUrl(url) + '" loading="lazy">';
    });
    // Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, function (m, t, url) {
      return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    // Bold, then italic, then strikethrough.
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // Restore inline code. Guard against a stray sentinel (should never happen).
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, n) {
      var c = codes[+n];
      return c == null ? m : "<code>" + escapeHtml(c) + "</code>";
    });
    return s;
  }

  var reUnordered = /^(\s*)([-*+])\s+(.*)$/;
  var reOrdered = /^(\s*)(\d+)[.)]\s+(.*)$/;

  function buildList(items) {
    var html = "";
    var stack = []; // { indent, tag }

    function openList(it, tag) {
      stack.push({ indent: it.indent, tag: tag });
      html += "<" + tag + "><li>" + inline(it.text);
    }

    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var tag = it.ordered ? "ol" : "ul";
      if (stack.length === 0) {
        openList(it, tag);
        continue;
      }
      var top = stack[stack.length - 1];
      if (it.indent > top.indent) {
        // Deeper: nest inside the current <li>.
        openList(it, tag);
      } else {
        // Same or shallower: close lists until we're at the right depth.
        while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
          html += "</li></" + stack.pop().tag + ">";
        }
        var cur = stack[stack.length - 1];
        if (cur.tag === tag) {
          html += "</li><li>" + inline(it.text);
        } else {
          // Same level but a different list type -> close and reopen.
          html += "</li></" + stack.pop().tag + ">";
          openList(it, tag);
        }
      }
    }
    while (stack.length) {
      html += "</li></" + stack.pop().tag + ">";
    }
    return html;
  }

  function splitRow(row) {
    return row
      .replace(/^\s*\|?/, "")
      .replace(/\|?\s*$/, "")
      .split("|")
      .map(function (c) {
        return c.trim();
      });
  }

  function isTableSeparator(line) {
    return (
      line.indexOf("|") !== -1 &&
      line.indexOf("-") !== -1 &&
      /^[\s|:-]+$/.test(line)
    );
  }

  function renderMarkdown(src, depth) {
    if (!src) return "";
    depth = depth || 0;
    // Strip NUL so document content can never spoof an inline-code sentinel.
    var lines = src.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // Blank line
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      // Fenced code block
      var fence = line.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        var lang = fence[2].trim();
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // consume closing fence
        out.push(
          '<pre class="code"><code' +
            (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
            ">" +
            escapeHtml(buf.join("\n")) +
            "</code></pre>"
        );
        continue;
      }

      // Page marker: <!-- page N --> (and generic HTML comments)
      var comment = line.match(/^\s*<!--\s*(.*?)\s*-->\s*$/);
      if (comment) {
        out.push('<div class="page-mark">' + escapeHtml(comment[1]) + "</div>");
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // Heading
      var h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var level = h[1].length;
        out.push("<h" + level + ">" + inline(h[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      // Table (header row followed by a separator row)
      if (
        line.indexOf("|") !== -1 &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        var heads = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (s) {
          var l = s.charAt(0) === ":";
          var r = s.charAt(s.length - 1) === ":";
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        var t = '<div class="table-wrap"><table><thead><tr>';
        heads.forEach(function (cell, idx) {
          var a = aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : "";
          t += "<th" + a + ">" + inline(cell) + "</th>";
        });
        t += "</tr></thead><tbody>";
        var j = i + 2;
        while (j < lines.length && lines[j].indexOf("|") !== -1 && !/^\s*$/.test(lines[j])) {
          var cells = splitRow(lines[j]);
          t += "<tr>";
          cells.forEach(function (cell, idx) {
            var a = aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : "";
            t += "<td" + a + ">" + inline(cell) + "</td>";
          });
          t += "</tr>";
          j++;
        }
        t += "</tbody></table></div>";
        out.push(t);
        i = j;
        continue;
      }

      // Blockquote
      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        // Bound recursion so a line of thousands of '>' cannot overflow the stack.
        var inner =
          depth < MAX_QUOTE_DEPTH
            ? renderMarkdown(quote.join("\n"), depth + 1)
            : "<p>" + inline(quote.join(" ")) + "</p>";
        out.push("<blockquote>" + inner + "</blockquote>");
        continue;
      }

      // Lists
      if (reUnordered.test(line) || reOrdered.test(line)) {
        var items = [];
        while (i < lines.length) {
          var l = lines[i];
          if (/^\s*$/.test(l)) {
            // A blank line ends the list unless the next line continues it.
            if (
              i + 1 < lines.length &&
              (reUnordered.test(lines[i + 1]) || reOrdered.test(lines[i + 1]))
            ) {
              i++;
              continue;
            }
            break;
          }
          var mu = reUnordered.exec(l);
          var mo = reOrdered.exec(l);
          if (mu) {
            items.push({ indent: mu[1].length, ordered: false, text: mu[3] });
            i++;
          } else if (mo) {
            items.push({ indent: mo[1].length, ordered: true, text: mo[3] });
            i++;
          } else if (/^\s+\S/.test(l) && items.length) {
            // Indented continuation of the previous item.
            items[items.length - 1].text += " " + l.trim();
            i++;
          } else {
            break;
          }
        }
        out.push(buildList(items));
        continue;
      }

      // Paragraph: gather consecutive plain lines.
      var para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*(```|~~~)/.test(lines[i]) &&
        !/^\s*#{1,6}\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
        !reUnordered.test(lines[i]) &&
        !reOrdered.test(lines[i]) &&
        !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push("<p>" + inline(para.join(" ")) + "</p>");
      }
    }

    return out.join("\n");
  }

  global.renderMarkdown = renderMarkdown;
})(window);
