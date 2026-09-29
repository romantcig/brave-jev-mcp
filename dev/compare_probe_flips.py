"""SHADOW-04：模型版本回归——比较两份 jev_probe.py 输出的来源级裁决翻转。

用法:
    python dev/compare_probe_flips.py <probe输出A.jev.json> <probe输出B.jev.json> [原Brave夹具.json]

流程（钉新模型 ID 的回归闸）:
    1. 改配置文件把 jev.model 钉到新模型版本 ID；
    2. 对同一份 Brave 夹具重跑 `python dev/jev_probe.py <夹具.json> "<intent>"`（新模型）；
    3. 把旧模型的 probe 输出与新模型的 probe 输出（以及原夹具，可选）交给本脚本。

比较规则:
    - 只比较来源级裁决（题门槛方向与 probe 打印口径一致：p >= 门槛即丢含等号；
      filler 需 has_original_reasoning < reasoning_protect 未保护）。
    - CJK 加成按来源占比套用（与管道口径一致：占比 > cjk_share 时五道丢弃门槛各加
      cjk_bonus）。probe 输出不含来源文本，需第三个参数给原 Brave 夹具——脚本会用
      dev/dump_local_rules.ts 重导候选集取 title + 幸存片段算占比；缺省不套 CJK 加成
      （两侧一致地不加，并打印说明）。
    - 阈值不一致、题库（questions/levels）哈希不一致的两份输入直接报错退出——比较必须
      同阈值同题目版本，改题目必须重调 Jev，不能沿用旧回答冒充新题结果。
    - 某侧非 200 / 无 answers 的来源按管道兜底语义记 KEEP(no-answer)；一侧可判一侧
      不可判、或两侧判定/原因不同，都计一次翻转。
    - 同模型自比应报零翻转——这是本脚本的自检。

探测证据（翻转数、逐源明细）落 `notes/private-jev-evidence.md` 的约定不变：内部工作
资料，不入库。

Python 与 jev_probe.py 同风格：标准库、无三方依赖。权威裁决实现在 src/filter/jev/，
本脚本只是打印参考（与 probe 的 verdict() 同理）。
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

# 与 src/filter/jev/verdict.ts 的 cjkShareOf 同口径的字符集（Han / 假名 / 谚文）；
# Python 标准库无 script 表，按码点区间近似（覆盖常用块，足够来源占比判定）。
CJK_CHAR = re.compile(
    "[\u3040-\u30ff\u31f0-\u31ff\u3130-\u318f\u1100-\u11ff"
    "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\U00020000-\U0002a6df\U0002a700-\U0002ebef\U0002f800-\U0002fa1f]"
)

SIX_KEYS = (
    "is_off_topic",
    "is_listing",
    "self_deprecated",
    "stale",
    "is_template_filler",
    "has_original_reasoning",
)
GATE_KEYS = ("is_off_topic", "is_listing", "self_deprecated", "stale", "is_template_filler")
GATE_THRESHOLDS = {
    "is_off_topic": "off_topic_drop",
    "is_listing": "listing_drop",
    "self_deprecated": "self_deprecated",
    "stale": "stale_drop",
    "is_template_filler": "filler_drop",
}


def load_probe(path):
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"error: probe 输出不存在: {path}")
    except ValueError as exc:
        sys.exit(f"error: probe 输出不是合法 JSON: {path} ({exc})")
    for key in ("model", "thresholds", "questions", "levels", "results"):
        if key not in data:
            sys.exit(f"error: {path} 缺顶层字段 {key}（不是 jev_probe.py 的输出？）")
    return data


def questions_hash(data):
    payload = json.dumps(
        {"questions": data["questions"], "levels": data["levels"]},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def cjk_share(title, snippets):
    whole = title + "".join(snippets)
    if not whole:
        return 0.0
    cjk = sum(len(m) for m in CJK_CHAR.findall(whole))
    return cjk / len(whole)


def load_candidates(fixture):
    """用 dump_local_rules.ts 重导候选集（与 probe 同一步骤），取 title + 幸存片段。"""
    fixture = Path(fixture)
    if not fixture.exists():
        sys.exit(f"error: 原夹具不存在: {fixture}")
    try:
        out = subprocess.run(
            ["node", "--import", "tsx", "dev/dump_local_rules.ts", str(fixture)],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        sys.exit(f"error: 重导候选集失败（dump_local_rules.ts）: {exc}")
    dump = json.loads(out)
    return {c["id"]: (c.get("title", ""), c.get("snippets", [])) for c in dump["sources"]}


def source_verdict(answers, thresholds, bonus):
    """按管道步 6 口径重算来源级裁决；六道判定概率任一缺失/超 [0,1] 防御式 KEEP（validation）。"""
    p = {}
    for key in SIX_KEYS:
        row = answers.get(key) if isinstance(answers, dict) else None
        value = row.get("noul") if isinstance(row, dict) else None
        if not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            return "KEEP(validation)"
        p[key] = value
    for key in GATE_KEYS:
        drop_at = thresholds[GATE_THRESHOLDS[key]] + bonus
        if p[key] < drop_at:
            continue
        if key == "is_template_filler" and p["has_original_reasoning"] >= thresholds["reasoning_protect"]:
            continue
        return f"DROP {key}"
    return "KEEP"


def side_verdict(entry, thresholds, bonus):
    """单侧判定：非 200 / 无 answers 记 KEEP(no-answer)，与管道兜底语义（失败按留）一致。"""
    if not isinstance(entry, dict) or entry.get("http") != 200:
        return "KEEP(no-answer)"
    answers = (entry.get("response") or {}).get("answers")
    if not isinstance(answers, dict):
        return "KEEP(no-answer)"
    return source_verdict(answers, thresholds, bonus)


def main():
    parser = argparse.ArgumentParser(
        description="比较两份 jev_probe.py 输出的来源级裁决翻转（SHADOW-04 回归闸）"
    )
    parser.add_argument("probe_a", help="旧模型的 probe 输出 .jev.json")
    parser.add_argument("probe_b", help="新模型的 probe 输出 .jev.json")
    parser.add_argument(
        "fixture", nargs="?", default=None,
        help="原 Brave 夹具 .json（可选；提供时按来源文本占比套 CJK 加成，与管道口径一致）",
    )
    args = parser.parse_args()

    a, b = load_probe(args.probe_a), load_probe(args.probe_b)

    if a["thresholds"] != b["thresholds"]:
        sys.exit("error: 两份输入的 thresholds 不一致——比较必须同阈值，先对齐配置再重跑。")
    hash_a, hash_b = questions_hash(a), questions_hash(b)
    if hash_a != hash_b:
        sys.exit(
            "error: 两份输入的题库版本不一致（questions/levels 哈希 "
            f"{hash_a} != {hash_b}）——改题目必须重调 Jev，不能拿旧回答比新题。"
        )

    thresholds = a["thresholds"]
    bonus = thresholds.get("cjk_bonus", 0.0)
    cjk_share_threshold = thresholds.get("cjk_share", 0.5)
    if args.fixture:
        candidates = load_candidates(args.fixture)
        shares = {sid: cjk_share(title, snips) for sid, (title, snips) in candidates.items()}
    else:
        shares = {}
        print("note: 未提供原夹具——CJK 加成不套用（两侧一致地按裸阈值判；需要完整口径请补第三参数）。\n")

    sid_set = sorted(set(a["results"]) | set(b["results"]))
    rows, flips = [], 0
    for sid in sid_set:
        share = shares.get(sid, 0.0)
        active_bonus = bonus if args.fixture and share > cjk_share_threshold else 0.0
        va = side_verdict(a["results"].get(sid), thresholds, active_bonus)
        vb = side_verdict(b["results"].get(sid), thresholds, active_bonus)
        flipped = va != vb
        flips += flipped
        rows.append((sid, va, vb, flipped, share))

    print(f"model A: {a['model']}   model B: {b['model']}")
    print(f"thresholds/questions/levels 一致（题库哈希 {hash_a}）\n")
    print(f"{'src':4} {'A':22} {'B':22} {'flip':5} {'cjk_share':9} url")
    for sid, va, vb, flipped, share in rows:
        url = (a["results"].get(sid) or b["results"].get(sid) or {}).get("url", "")
        mark = "FLIP" if flipped else "-"
        print(f"{sid:4} {va:22} {vb:22} {mark:5} {share:9.2f} {url[:60]}")
    print(f"\n来源数 {len(rows)}，裁决翻转 {flips} 处。（翻转超过小阈值才人工复核；证据落 notes/private-jev-evidence.md）")


if __name__ == "__main__":
    main()
