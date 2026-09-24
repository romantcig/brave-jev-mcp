"""对一份 Brave 夹具跑 Jev 题库（TypeSafe 直连），输出逐来源裁决表并把原始响应存到 fixtures/<name>.jev.json。
用法: python dev/jev_probe.py fixtures/jev_release_default.json "<intent>"
后端：TypeSafe 直连（noul 协议，并发 6）；key 从环境变量 jev_API_KEY 或 TYPESAFE_API_KEY 读。代理从 HTTPS_PROXY 环境变量读，未设则直连。
OpenRouter / Vercel 网关通道已于 2026-09-24 退役（见 notes/decisions-log.md）。
题库与阈值集中在 QUESTIONS / THRESHOLDS，改策略只改这里。
"""
import json, sys, time, urllib.request, concurrent.futures as cf
from pathlib import Path

import os
URL = "https://api.typesafe.ai/v1/systemone"; MODEL = "jev-latest"; WORKERS = 6; BOOL = "noul"

def get_key():
    k = os.environ.get("jev_API_KEY") or os.environ.get("TYPESAFE_API_KEY")
    assert k, "jev_API_KEY / TYPESAFE_API_KEY missing"
    return k

def prob(ans):
    """两种协议统一取"是"的概率"""
    return ans["noul"] if "noul" in ans else ans["probability"]

# ---- 题库（英文题干，noul 在网关协议里叫 boolean）----
SOURCE_QUESTIONS = {
 "worth_keeping": "`source` contains information or analysis about the subject of `query` that a reader pursuing `intent` would lose if this source were removed, beyond restating widely reported launch facts (funding, pricing, speed claims, founder background).",
 "is_primary": "The author of `source` is the company, person, or project that `query` is about (their own announcement, documentation, repository, or post).",
 "has_original_reasoning": "`source` contains the author's own evaluation, criticism, comparison, or argument with stated reasons, not just reported claims.",
 "is_attributed_rewrite": "The specific facts in `source` are presented as coming from another outlet, bulletin, or the company's own materials (phrases like 'according to', 'as reported', 'official materials show'), with no facts the author obtained independently.",
 "is_template_filler": "`source` mostly repeats the topic name and generic phrasing without specific facts, or reads like a template article assembled from headlines.",
 "is_off_topic": "`source` is not about the subject of `query`.",
}
SNIPPET_LEVELS = [
 "Navigation, metadata, boilerplate, or unrelated to `query`",
 "Mentions the subject of `query` but adds no specific information",
 "States specific information or analysis that directly serves `intent`",
]
THRESHOLDS = {"off_topic_drop":0.85,"filler_drop":0.80,"keep_min":0.50,"snippet_drop_below":1.0}

def build_questions(n_snips):
    q = {k:{"type":BOOL,"instructions":v} for k,v in SOURCE_QUESTIONS.items()}
    for i in range(n_snips):
        q[f"snip{i}"] = {"type":"score","instructions":f"How useful is `source.snippets[{i}]` for `intent`?","criteria":SNIPPET_LEVELS}
    return q

def call(key, state, questions):
    """单次请求；网络异常（代理握手超时等）也按可重试处理"""
    body = json.dumps({"model":MODEL,"state":state,"questions":questions}).encode()
    headers = {"Authorization":f"Bearer {key}","Content-Type":"application/json"}
    req = urllib.request.Request(URL, data=body, method="POST", headers=headers)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': proxy} if proxy else {}))
    t = time.time()
    for attempt in range(6):
        try:
            with opener.open(req, timeout=60) as r: raw = r.read().decode(); code = r.status
        except urllib.error.HTTPError as e: raw = e.read().decode(); code = e.code
        except Exception as e:  # 代理/TLS 超时
            raw = json.dumps({"error": {"message": f"network: {e}"}}); code = 599
        if code not in (429, 529, 599): break
        time.sleep(1.5 * (2 ** attempt))   # 免费档对该模型限流严格；指数退避
    return code, json.loads(raw), round(time.time()-t,2)

def verdict(a, n_snips):
    p = {k:prob(a[k]) for k in SOURCE_QUESTIONS}
    if p["is_off_topic"] >= THRESHOLDS["off_topic_drop"]: v="DROP off_topic"
    elif p["is_template_filler"] >= THRESHOLDS["filler_drop"] and p["has_original_reasoning"] < 0.5: v="DROP filler"
    elif p["worth_keeping"] < THRESHOLDS["keep_min"] and p["is_attributed_rewrite"] > 0.5: v="DROP rewrite"
    else: v="KEEP"
    kept = [i for i in range(n_snips) if a[f"snip{i}"]["score"] >= THRESHOLDS["snippet_drop_below"]]
    return v, p, kept

def main():
    fx = Path(sys.argv[1]); intent = sys.argv[2]
    d = json.load(open(fx, encoding="utf-8")); query = d["request"]["q"]
    key = get_key(); results = {}
    srcs = d["response"]["grounding"]["generic"]
    def one(i, s):
        sid = f"s{i}"
        state = {"query":query,"intent":intent,"source":{"id":sid,"url":s["url"],"title":s["title"],"snippets":s["snippets"]}}
        code, resp, dt = call(key, state, build_questions(len(s["snippets"])))
        return sid, s, code, resp, dt
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for sid, s, code, resp, dt in ex.map(lambda p: one(*p), enumerate(srcs)):
            results[sid] = {"url":s["url"],"http":code,"latency_s":dt,"response":resp}
    out = fx.with_suffix(".jev.json")
    json.dump({"intent":intent,"backend":"direct","model":MODEL,"thresholds":THRESHOLDS,"questions":SOURCE_QUESTIONS,"levels":SNIPPET_LEVELS,"results":results}, open(out,"w",encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{'src':4} {'verdict':14} keep prim reas rewr fill off  snips kept/total  tok   s   url")
    tot_tok=0; tot_chars_in=0; tot_chars_kept=0
    for i, s in enumerate(srcs):
        r = results[f"s{i}"]
        if r["http"] != 200: print(f"s{i:<3} HTTP {r['http']} {str(r['response'])[:100]}"); continue
        a = r["response"]["answers"]; n=len(s["snippets"])
        v, p, kept = verdict(a, n); u = r["response"]["usage"]; tok = u.get("input_tokens", u.get("inputTokens")); tot_tok += tok
        tot_chars_in += sum(len(x) for x in s["snippets"])
        if v=="KEEP": tot_chars_kept += sum(len(s["snippets"][k]) for k in kept)
        print(f"s{i:<3} {v:14} {p['worth_keeping']:.2f} {p['is_primary']:.2f} {p['has_original_reasoning']:.2f} {p['is_attributed_rewrite']:.2f} {p['is_template_filler']:.2f} {p['is_off_topic']:.2f}  {len(kept):>2}/{n:<2}          {tok:>5} {r['latency_s']:>4} {s['url'][:60]}")
    print(f"\ninput tokens to Jev: {tot_tok}  | chars in: {tot_chars_in} -> kept: {tot_chars_kept} ({100*tot_chars_kept/max(1,tot_chars_in):.0f}%)")
    print("saved", out)
main()
