#!/usr/bin/env python3
"""Build the laya-train JSONL for the filler matcher.

Run from server/:  python3 scripts/laya/train/gen_data.py [--out scripts/laya/train/train.jsonl]

Training utterances come ONLY from fillers.json examples, paraphrases.txt (hand-written) and
negatives.txt (hand-written, target = generic-ack). Exact matches against dev/holdout/coherence
texts are dropped (the eval files are read only for that normalised-string check).

The question mirrors src/latency/matchFiller.ts rankJev() exactly (instructions, criteria
{what, examples}, generic-ack last). Because laya-serve runs LAYA_TOURNAMENT_GROUP=64 and the question has
102 options, runtime reads it as two contiguous 51-option groups (shortlist.predict_tournament) and then a
final 2-finalist question. Each utterance therefore yields two rows: the 51-option half that holds the
target, and a 2-option final (target vs a random option from the other half). The target's own example
text is removed from its option (leave-one-out) when the utterance IS that example.
"""
import argparse, json, os, random, re

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CATCH_ALL = "generic-ack"
CATCH_WHAT = ("Use when the utterance has no request or answer that matches any other option: off-topic chatter, "
              "side talk to someone else in the room, background noise, or fragments with no request. "
              "Prefer it over any specific option that only shares a word with the utterance.")
INSTR = "Which option best describes what the caller just said?"
GROUP = 64

norm = lambda s: re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "train.jsonl"))
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    fillers = json.load(open(os.path.join(SRV, "src/latency/fillers.json")))
    ids = [f["id"] for f in fillers] + [CATCH_ALL]
    crit = {f["id"]: {"what": f["when"], "examples": list(f["examples"])} for f in fillers}
    crit[CATCH_ALL] = {"what": CATCH_WHAT}

    banned = set()
    for n in ("dev", "holdout", "coherence"):
        d = json.load(open(os.path.join(SRV, "scripts/eval", n + ".json")))
        d = d["phrases"] if isinstance(d, dict) else d
        for r in d:
            for t in (r["text"] if isinstance(r.get("text"), list) else [r.get("text", "")]):
                banned.add(norm(t))

    utts = []  # (text, target id, source, example_to_drop)
    for f in fillers:
        for e in f["examples"]:
            utts.append((e, f["id"], "example", e))
    for line in open(os.path.join(HERE, "paraphrases.txt")):
        if line.strip():
            fid, *ps = line.rstrip("\n").split("|")
            utts += [(p, fid, "paraphrase", None) for p in ps if p.strip()]
    utts += [(l.strip(), CATCH_ALL, "negative", None) for l in open(os.path.join(HERE, "negatives.txt")) if l.strip()]

    n = len(ids)
    parts = -(-n // GROUP)
    halves = [ids[i * n // parts:(i + 1) * n // parts] for i in range(parts)]
    print("option groups:", [len(h) for h in halves])

    def question(labels, target, drop):
        c = {}
        for l in labels:
            v = dict(crit[l])
            if l == target and drop and "examples" in v:
                v["examples"] = [e for e in v["examples"] if e != drop]
            c[l] = v
        return {"filler": {"type": "choice", "instructions": INSTR, "criteria": c}}

    rows, dropped, seen = [], 0, set()
    for text, tgt, src, drop in utts:
        if norm(text) in banned or (norm(text), tgt) in seen:
            dropped += 1
            continue
        seen.add((norm(text), tgt))
        half = next(h for h in halves if tgt in h)
        other = rng.choice([x for h in halves if h is not half for x in h])
        finalists = [x for x in ids if x in (tgt, other)]  # criteria order, like the runtime
        for labels in (half, finalists):
            rows.append({"state": text, "questions": question(labels, tgt, drop),
                         "expected": {"filler": tgt}, "meta": src})
    rng.shuffle(rows)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    by = {}
    for t, _, s, _ in utts:
        by[s] = by.get(s, 0) + 1
    print("utterances", len(utts) - dropped, "dropped(dup/eval-overlap)", dropped, "by source", by, "rows", len(rows), "->", a.out)

main()
