# An unknown corner

Outcome: **found**

EVE confirmed by direct contact.

- Inferred location: [4,6]
- Location confidence: 100.0%
- Status: active (100.0%)
- Actions: 14
- Battery remaining: 8/26
- Time used: 18/140

## Recommended next step

Approach EVE and assess safe retrieval.

Confidence is the model's posterior probability, not an independently calibrated success rate. Only direct contact confirms EVE's location and status.

## Evidence

- initial_signal at t=0: `{"type":"initial_signal","origin":[0,0],"bearing":1.3203863860606497,"strength":0.1362020306285344,"timestamp":0}`
- scan_signal at t=2: `{"type":"scan_signal","origin":[0,0],"bearing":0.7799811531124781,"range":9.423497086007249,"timestamp":2}`
- scan_signal at t=7: `{"type":"scan_signal","origin":[3,0],"bearing":1.3370626297672872,"range":4.112043335244009,"timestamp":7}`
- clue at t=7: `{"type":"clue","id":"clue-6","position":[4,1],"hint":[4.585111530172661,6.874213355126767],"sigma":1.5,"status":"active","reliability":0.8,"timestamp":7}`
- scan_signal at t=12: `{"type":"scan_signal","origin":[4,2],"bearing":1.8081478338197658,"range":5.059591716773872,"timestamp":12}`
- clue at t=12: `{"type":"clue","id":"clue-5","position":[5,2],"hint":[4.610942365924848,7.170376077353346],"sigma":1.5,"status":"active","reliability":0.8,"timestamp":12}`
- scan_signal at t=17: `{"type":"scan_signal","origin":[4,5],"bearing":2.300966186472479,"range":4.071944225976859,"timestamp":17}`
- contact at t=18: `{"type":"contact","location":[4,6],"status":"active","timestamp":18}`
