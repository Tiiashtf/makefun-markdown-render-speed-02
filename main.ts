// Entry point for the markdown-render-speed-02 harness.
// Reads every case from /input/cases.json, renders each with parse,
// writes /output/html.json.
//
// Written from scratch for this entry (not a copy of the kit baseline).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(`${inputDir}/cases.json`, 'utf8'));
const html = [];
for (const c of cases) html.push(parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/html.json`, JSON.stringify(html));
