#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request

BASE = "https://movilidad.aytoburgos.es/rutas-en-directo"
COMMON = {
    "p_p_id": "as_asac_isaenext_IsaenextWebPortlet",
    "p_p_lifecycle": "2",
    "p_p_state": "normal",
    "p_p_mode": "view",
    "p_p_cacheability": "cacheLevelPage",
}
def get_json(params):
    query = urllib.parse.urlencode({**COMMON, **params})
    url = BASE + "?" + query
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; SAE-Spotter/1.0)",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://movilidad.aytoburgos.es/rutas-en-directo",
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read()
    return url, json.loads(body.decode("utf-8-sig"))

url, nodes = get_json({"p_p_resource_id":"resourceNodes"})
print("NODES_URL", url)
print("NODES_TYPE", type(nodes).__name__, "COUNT", len(nodes))
print("FIRST_NODE", json.dumps(nodes[0], ensure_ascii=False) if nodes else "none")
for node in nodes[:5]:
    stop_id = str(node.get("num", ""))
    url, result = get_json({
        "p_p_resource_id":"resourceEstimations",
        "_as_asac_isaenext_IsaenextWebPortlet_tipo":"1",
        "_as_asac_isaenext_IsaenextWebPortlet_nodoIds":stop_id,
    })
    print("ESTIMATION_URL", url)
    print("STOP_ID", stop_id, "RESPONSE_TYPE", type(result).__name__,
          "COUNT", len(result) if isinstance(result,list) else "-")
    print("ESTIMATION_SAMPLE", json.dumps(result[:1] if isinstance(result,list) else result,
                                           ensure_ascii=False)[:5000])
