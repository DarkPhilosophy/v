// Run with node tests/shiki-grammar-cache.cjs. Dependencies and fixtures stay isolated.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shiki-regression-"));
async function main() {
    execFileSync("npm", ["install", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund", "@vap/shiki@0.10.3", "esbuild@0.25.12"], { stdio: "pipe" });
    const fixtureRequire = createRequire(path.join(temporary, "package.json"));
    const revision = fs.readFileSync(path.resolve(__dirname, "../upstream.lock"), "utf8").trim();
    const upstream = `https://raw.githubusercontent.com/Vendicated/Vencord/${revision}/src/plugins/shikiCodeblocks.desktop/api/shiki.ts`;
    const assets = "https://cdn.jsdelivr.net/gh/shikijs/textmate-grammars-themes@bc5436518111d87ea58eb56d97b3f9bec30e6b83/packages/";
    async function download(url, name) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fixture download failed: ${response.status}`);
        fs.writeFileSync(path.join(temporary, name), await response.text());
    }
    await Promise.all([
        download(upstream, "shiki.original.ts"),
        download("https://cdn.jsdelivr.net/gh/Vencord/ShikiPluginAssets@75d69df9fdf596a31eef8b7f6f891231a6feab44/grammars.json", "languages.json"),
        download(assets + "tm-themes/themes/dark-plus.json", "theme.json"),
        ...["markdown", "powershell"].map(id => download(assets + `tm-grammars/grammars/${id}.json`, `${id}.json`))
    ]);
    const source = path.join(temporary, "src/plugins/shikiCodeblocks.desktop/api/shiki.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(path.join(temporary, "shiki.original.ts"), source);
    execFileSync("git", ["apply", path.resolve(__dirname, "../patches/shiki-grammar-cache.patch")], { cwd: temporary });
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {transformSync} = fixtureRequire('esbuild');
const {getHighlighter,setWasm} = fixtureRequire('@vap/shiki').shiki;
const wasm=fs.readFileSync(fixtureRequire.resolve('vscode-oniguruma/release/onig.wasm'));
setWasm(wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength));
const theme=fixtureRequire('./theme.json');
const registrations=Object.fromEntries(['markdown','powershell'].map(id=>[id,{...fixtureRequire('./languages.json').find(l=>l.name===id),id,grammar:fixtureRequire(`./${id}.json`)}]));
async function setup(file){
 let highlighter=await getHighlighter({theme,langs:[]});let rebuilds=0;
 const client={async run(method,args){try{switch(method){
 case 'setHighlighter': highlighter=await getHighlighter({theme,langs:args.langs});rebuilds++;return;
 case 'loadLanguage':return await highlighter.loadLanguage(args.lang);
 case 'loadTheme':return await highlighter.loadTheme(theme);
 case 'codeToThemedTokens':return highlighter.codeToThemedTokens(args.code,args.lang,theme.name);
 case 'getTheme':return {themeData:JSON.stringify(highlighter.getTheme(theme.name))};
 default:throw new Error(method);
 }}catch(e){return null;}}};
 const modules={
 '@plugins/shikiCodeblocks.desktop/hooks/useTheme':{dispatchTheme(){}},
 '@utils/dependencies':{},'@vap/core/ipc':{},
 './languages':{languages:registrations,resolveLang:id=>registrations[id]??Object.values(registrations).find(l=>l.aliases?.includes(id)),getGrammar:async l=>l.grammar},
 './themes':{themes:{DarkPlus:theme.name}}
 };
 const mod={exports:{}};
 vm.runInNewContext(transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs'}).code,{module:mod,require:id=>{assert.ok(id in modules,id);return modules[id];}});
 const s=mod.exports.shiki;s.client=client;s.clientPromise=Promise.resolve(client);s.currentThemeUrl=theme.name;s.loadedThemes.add(theme.name);
 return {s,rebuilds:()=>rebuilds};
}
async function verify(file) {
 const {s,rebuilds}=await setup(file);
 await s.loadLang('markdown');
 await Promise.all([s.loadLang('powershell'),s.loadLang('ps1')]);
 const code='Write-Host "test"';
 const tokens=await s.tokenizeCode(code,'ps1');
 assert.ok(Array.isArray(tokens),'worker must return tokens, not swallowed error null');
 assert.equal(tokens.flat().map(t=>t.content).join(''),code);
 assert.ok(new Set(tokens.flat().map(t=>t.color)).size>1,'PowerShell must be syntax highlighted');
 assert.equal(rebuilds(),1,'one registry rebuild, duplicate loads deduplicated');
 const markdown=await s.tokenizeCode('```powershell\n'+code+'\n```','markdown');
 assert.ok(Array.isArray(markdown),'previous grammar remains available');
 assert.deepEqual([...s.loadedLangs].sort(),['markdown','powershell']);

}
await assert.rejects(() => verify(path.join(temporary, "shiki.original.ts")), /worker must return tokens/);
await verify(source);
console.log("PASS: baseline fails; patched real TextMate preserves highlighting, aliases and concurrent loads");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
