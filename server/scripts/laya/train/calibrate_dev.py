#!/usr/bin/env python3
"""Fit temperatures for a fine-tuned checkpoint on scripts/eval/dev.json ONLY, at the option counts served.

usage: python calibrate_dev.py <checkpoint_dir> [--write-config]
Follows laya.calibrate: records_from_labeled -> fit_temperature_map -> Agent.save_calibration (calibration.json
in the checkpoint dir). laya-serve has no calibration-file switch, so --write-config also writes the fitted
temperature / temperature_by_options into the checkpoint's rl_agent_config.json (what laya-train itself does).
Records: for each dev row, the 51-option tournament group holding an accepted filler (target uniform over the
accepted-category fillers in that group) and the 2-option final (accepted filler vs a random one from the other group).
MIN_BUCKET_N (2000) is lowered to 40 so per-bucket temperatures are fitted from this small set.
"""
import json, os, random, sys
os.environ.setdefault("HF_HUB_OFFLINE", "1"); os.environ.setdefault("USE_TF", "0")
import numpy as np
import laya
from laya import calibrate
calibrate.MIN_BUCKET_N = 40
HERE = os.path.dirname(os.path.abspath(__file__)); SRV = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
ck = sys.argv[1]
fillers = json.load(open(os.path.join(SRV, "src/latency/fillers.json")))
cat = {f["id"]: f["category"] for f in fillers}
CATCH = "generic-ack"
sys.path.insert(0, HERE)
import importlib.util
src = open(os.path.join(HERE, "gen_data.py")).read().split("def main")[0]
ns = {"__file__": os.path.join(HERE, "gen_data.py")}; exec(src, ns)
crit = {f["id"]: {"what": f["when"], "examples": f["examples"]} for f in fillers}; crit[CATCH] = {"what": ns["CATCH_WHAT"]}
ids = list(crit); n = len(ids); halves = [ids[:n // 2], ids[n // 2:]]
def q(labels): return {"filler": {"type": "choice", "instructions": ns["INSTR"], "criteria": {l: crit[l] for l in labels}}}
rng = random.Random(1)
dev = json.load(open(os.path.join(SRV, "scripts/eval/dev.json")))
pairs = []
for r in dev:
    ok = set(r.get("acceptCategories") or []) | ({r["expectCategory"]} if r.get("expectCategory") else set())
    good = [i for i in ids if cat.get(i) in ok]
    if not good: continue
    for h in halves:
        g = [i for i in h if i in good]
        if g: pairs.append((r["text"], q(h), {"filler": [1 / len(g) if i in g else 0.0 for i in h]}))
    t = rng.choice(good); o = rng.choice(halves[1] if t in halves[0] else halves[0])
    fin = [i for i in ids if i in (t, o)]
    pairs.append((r["text"], q(fin), {"filler": [1.0 if i == t else 0.0 for i in fin]}))
agent = laya.load(ck, device="mps")
print("old temps:", agent.temperature, agent.temperature_by_options)
recs = calibrate.records_from_labeled(agent, pairs)
fit = calibrate.fit_temperature_map(recs)
print(json.dumps({k: fit[k] for k in ("temperature", "temperature_by_options", "n_by_bucket", "temperature_clamped")}, indent=1))
agent.temperature = fit["temperature"]; agent.temperature_by_options = fit["temperature_by_options"]
agent.save_calibration(os.path.join(ck, "calibration.json"))
if "--write-config" in sys.argv:
    p = os.path.join(ck, "rl_agent_config.json"); c = json.load(open(p))
    c["temperature"] = fit["temperature"]; c.pop("temperature_by_options", None)
    if fit["temperature_by_options"]: c["temperature_by_options"] = fit["temperature_by_options"]
    json.dump(c, open(p, "w"), indent=2); print("wrote", p)
