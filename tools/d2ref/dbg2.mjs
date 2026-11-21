import markdownit from 'markdown-it';
import { setMarkdownIt, loadMetrics, newRuler, measureMarkdown } from '../../public/d2/textmeasure.js';
setMarkdownIt(markdownit); await loadMetrics();
const ruler = newRuler();
console.log(measureMarkdown(process.argv[2].replace(/\\n/g, '\n'), ruler, 'SourceSansPro', 'SourceCodePro', 16));
console.log(ruler.spaceWidth({Family:'SourceCodePro',Style:'regular',Size:16}), ruler.measurePrecise({Family:'SourceSansPro',Style:'regular',Size:16}, '床前明月光，'));
