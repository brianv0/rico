package main

import (
	"fmt"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/net/html"

	"oss.terrastruct.com/d2/lib/textmeasure"
)

// mdtree prints the HTML tree goquery builds from the rendered markdown (debugging aid for htmlparse.js).
func mdtree(in input) interface{} {
	r, err := textmeasure.RenderMarkdown(in.Text)
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(r))
	if err != nil {
		return map[string]interface{}{"err": err.Error()}
	}
	var sb strings.Builder
	var walk func(n *html.Node, d int)
	walk = func(n *html.Node, d int) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			switch c.Type {
			case html.TextNode:
				fmt.Fprintf(&sb, "%s#text %q\n", strings.Repeat(" ", d), c.Data)
			case html.ElementNode:
				fmt.Fprintf(&sb, "%s<%s>\n", strings.Repeat(" ", d), c.Data)
				walk(c, d+1)
			default:
				fmt.Fprintf(&sb, "%s#other %q\n", strings.Repeat(" ", d), c.Data)
			}
		}
	}
	walk(doc.Find("body").First().Nodes[0], 0)
	return map[string]interface{}{"html": r, "tree": sb.String()}
}
