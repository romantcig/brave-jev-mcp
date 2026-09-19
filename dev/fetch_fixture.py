"""抓取真实 Brave LLM Context 响应存为测试夹具。
用法: python dev/fetch_fixture.py "<query>" <name> [--strict] [--freshness pm] [--urls 12] [--tokens 9000] [--per-url 750] [--count 20]
key 从 ~/.claude.json 的 brave 条目读取; 代理走 127.0.0.1:10808。
"""
import json, sys, os, argparse, urllib.request, urllib.parse, time
from pathlib import Path
ap=argparse.ArgumentParser(); ap.add_argument('query'); ap.add_argument('name')
ap.add_argument('--strict',action='store_true'); ap.add_argument('--freshness',default=None)
ap.add_argument('--urls',type=int,default=12); ap.add_argument('--tokens',type=int,default=9000)
ap.add_argument('--per-url',type=int,default=750); ap.add_argument('--count',type=int,default=20)
a=ap.parse_args()
cfg=json.load(open(Path.home()/'.claude.json',encoding='utf-8'))
key=cfg['mcpServers']['brave']['env']['BRAVE_API_KEY']
params={'q':a.query,'count':a.count,'maximum_number_of_urls':a.urls,'maximum_number_of_tokens':a.tokens,'maximum_number_of_tokens_per_url':a.per_url}
if a.freshness: params['freshness']=a.freshness
if a.strict: params['context_threshold_mode']='strict'
url='https://api.search.brave.com/res/v1/llm/context?'+urllib.parse.urlencode(params)
req=urllib.request.Request(url,headers={'Accept':'application/json','X-Subscription-Token':key})
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:10808'}))
t=time.time()
with opener.open(req,timeout=60) as r: data=json.loads(r.read().decode())
dt=time.time()-t
out=Path(__file__).resolve().parent.parent/'fixtures'/f'{a.name}.json'
json.dump({'request':params,'fetched_at':time.strftime('%Y-%m-%dT%H:%M:%S'),'latency_s':round(dt,2),'response':data},open(out,'w',encoding='utf-8'),ensure_ascii=False,indent=1)
g=data['grounding']['generic']; n_snip=sum(len(x['snippets']) for x in g); chars=sum(len(s) for x in g for s in x['snippets'])
jsonld=sum(1 for x in g for s in x['snippets'] if s.lstrip().startswith('{'))
print(f'{out.name}: {len(g)} sources, {n_snip} snippets ({jsonld} JSON-like), {chars} chars, {dt:.1f}s')
for x in g: print('  ',len(x['snippets']),'snips',sum(len(s) for s in x['snippets']),'chars',x['url'][:90])
