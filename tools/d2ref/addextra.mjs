// appends the hand-written icon userinfo cases to extra.jsonl (once)
import fs from 'node:fs';
const cases = [
  'a: {icon: "https://bob@example.com/i.svg"}\nb: {icon: "https://user:pa%20ss@example.com/x.png"}\nc: {icon: "http://üser:p%C3%A4@h.example/x.png"}\na -> b: {icon: "https://:x@h.example/y.png"}\n',
  'x: {shape: image; icon: "https://u:@h.example/a.png"}\ny: {icon: "https://a%40b:c%3Ad@h.example/q?x=1#f"}\nlayers: {l: {z: {icon: "https://zed@h.example/z.png"}}}\n',
];
const f = new URL('./extra.jsonl', import.meta.url);
if (!fs.readFileSync(f, 'utf8').includes('extra: icon userinfo')) {
  fs.appendFileSync(f, cases.map((text, i) => JSON.stringify({ from: `extra: icon userinfo ${i}`, path: 'x.d2', text })).join('\n') + '\n');
}
