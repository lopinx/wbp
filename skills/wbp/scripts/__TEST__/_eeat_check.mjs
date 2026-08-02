function checkEeat(content, excerpt, siteOrigin){
  const fullText = (content||"")+" "+(excerpt||"");
  const sig=[];
  if(/rel=["']author["']/.test(fullText) || /(^|\n)\s*(<p[^>]*>\s*)?(作者|Author|Redakcja|Przez|By|–|—)\s*[:：]/m.test(fullText)) sig.push("author");
  const ext=[...(content||"").matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m=>m[1]).filter(u=>!siteOrigin||!u.startsWith(siteOrigin));
  if(ext.length) sig.push("source");
  return sig;
}
// expect: 该用例**必须**命中的信号集合（精确匹配）
const cases=[
  ["纯正文无信号", "<p>文章内容</p>", "https://ex.com", []],
  ["段首中文署名", "<p>作者：张三</p><p>正文</p>", "https://ex.com", ["author"]],
  ["rel=author属性", "<a rel=\"author\">编辑</a><p>正文</p>", "https://ex.com", ["author"]],
  ["外链source", "<p>正文</p><a href=\"https://other.com/x\">ref</a>", "https://ex.com", ["source"]],
  ["内链不算source", "<p>正文</p><a href=\"https://ex.com/p1\">内</a>","https://ex.com", []],
  ["body中偶然提及作者不误判", "<p>这个作者是好人</p>", "https://ex.com", []],
  ["破折号无冒号不算署名", "<p>— 编辑团队</p>", "https://ex.com", []],
];
let pass=0, fail=0;
for(const [name,c,ori,expect] of cases){
  const s=checkEeat(c,"",ori);
  const ok = JSON.stringify(s)===JSON.stringify(expect);
  ok?pass++:fail++;
  console.log((ok?"✓":"✗")+" 实际["+s.join("+")+"] 期望["+expect.join("+")+"] <- "+name);
}
let pass=0, fail=0;
for(const [name,c,ori,expect] of cases){
  const s=checkEeat(c,"",ori);
  const ok = (s.length===0 && expect[0]==="无") || (s.length>=1 && expect[0]!=="无");
  ok?pass++:fail++;
  console.log((ok?"✓":"✗")+" ["+s.join("+")+"] <- "+name);
}
console.log(`\n${pass}/${pass+fail} 通过`);
