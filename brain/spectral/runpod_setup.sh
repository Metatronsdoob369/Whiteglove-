#!/bin/bash
# RunPod GPU Ingest Setup
# Run this ONCE inside your RunPod terminal after the pod starts.
# Then run the ingest command at the bottom.
#
# Recommended pod: RTX 4090 · 24GB VRAM · PyTorch 2.x template
# Cost: ~$0.44/hr · Expected ingest time: ~20 minutes · Total: ~$0.15

set -e

echo "=== [1/4] Installing Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &>/tmp/ollama.log &
sleep 5

echo "=== [2/4] Pulling mxbai-embed-large ==="
ollama pull mxbai-embed-large
echo "Model ready."

echo "=== [3/4] Installing qdrant-client ==="
pip install qdrant-client --quiet

echo "=== [4/4] Ready. ==="
echo ""
echo "Now run the ingest:"
echo ""
echo "  python3 legal_temporal_ingest.py \\"
echo "    --shards  /path/to/shards/legal \\"
echo "    --heatmap /path/to/shards/vault/legal_heatmap.json \\"
echo "    --qdrant  http://100.113.215.46:6340 \\"
echo "    --ollama  http://localhost:11434 \\"
echo "    --batch   200 \\"
echo "    --resume  4397"
echo ""
echo "Qdrant writes go directly to your Pi at 100.113.215.46:6340."
echo "Kill the pod when the ingest completes."
