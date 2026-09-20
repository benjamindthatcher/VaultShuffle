import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ImageResponse } from 'next/og.js';
import React from 'react';
import ts from 'typescript';

// Read the registry's literal metadata without loading article content or databases.
const require = createRequire(import.meta.url);
const source = await readFile('lib/blog/posts.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const scheduleSource = await readFile('lib/blog/schedule.ts', 'utf8');
const scheduleCompiled = ts.transpileModule(scheduleSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const schedule = { exports: {} };
new Function('module', 'exports', scheduleCompiled)(schedule, schedule.exports);
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
  (name) => name === '@/lib/blog/schedule' ? schedule.exports : name.startsWith('@/components/blog/posts/') ? {} : require(name),
  loaded, loaded.exports,
);
const h = React.createElement;
await mkdir('public/assets/blog', { recursive: true });
for (const post of loaded.exports.BLOG_POSTS) {
  if (!post.socialImage) continue;
  const card = h('div', { style: {
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    width: '100%', height: '100%', padding: '58px 68px', color: '#f5f0ff',
    background: 'radial-gradient(circle at 95% 0%, #462278, transparent 65%), linear-gradient(135deg, #13172e, #090c1d)',
    borderBottom: '8px solid #aa69ef',
  } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 26, color: '#d2a6fa' } },
      h('span', null, 'VaultShuffle'), h('span', { style: { fontSize: 22 } }, 'Notes from the Vault')),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 22 } },
      h('div', { style: { display: 'flex', color: '#d2a6fa', fontSize: 22, letterSpacing: 3, textTransform: 'uppercase' } }, post.topic),
      h('div', { style: { display: 'flex', fontSize: 60, fontWeight: 700, lineHeight: 1.12, letterSpacing: -2 } }, post.heading)),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 23, color: '#b5b4cd' } },
      h('span', null, 'vaultshuffle.com/blog'), h('span', null, `${post.readingMinutes} min read`)));
  const image = new ImageResponse(card, { width: 1200, height: 630 });
  await writeFile(join('public', post.socialImage), Buffer.from(await image.arrayBuffer()));
  console.log(`Rendered ${post.socialImage}`);
}
