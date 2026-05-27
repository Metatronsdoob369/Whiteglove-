#!/bin/bash
# launch_gpu_ingest.sh — Mac-side: push scripts to pod and kick off full ingest
# Usage: bash launch_gpu_ingest.sh <ssh_host> <ssh_port>
# Example: bash launch_gpu_ingest.sh ssh5.vast.ai 15238

set -e

HOST=${1:?Usage: $0 <ssh_host> <ssh_port>}
PORT=${2:?Usage: $0 <ssh_host> <ssh_port>}
KEY=~/.ssh/vast_key
ROOT=/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk
SSH="ssh -i $KEY -p $PORT root@$HOST"
SCP="rsync -avz -e 'ssh -i $KEY -p $PORT'"

echo "=== Pushing scripts and shards to pod $HOST:$PORT ==="

# Push spectral scripts
rsync -avz -e "ssh -i $KEY -p $PORT" \
  "$ROOT/brain/spectral/" \
  "root@$HOST:/root/spectral/"

# Push existing shards (scraped alabama + vault heatmaps)
rsync -avz -e "ssh -i $KEY -p $PORT" \
  "$ROOT/brain/shards/" \
  "root@$HOST:/root/shards/"

# Push scrapers
rsync -avz -e "ssh -i $KEY -p $PORT" \
  "$ROOT/brain/scrapers/" \
  "root@$HOST:/root/scrapers/"

echo ""
echo "=== Running bootstrap on pod ==="
$SSH "bash /root/spectral/pod_bootstrap.sh"

echo ""
echo "=== Starting full ingest (all Alabama titles) ==="
$SSH "nohup bash -c '
  cd /root
  echo \"--- Scraping full Alabama Code ---\"
  python3 scrapers/alabama_code_scraper.py --out shards/alabama_full
  echo \"--- Running heatmap ---\"
  python3 spectral/legal_heatmap.py --shards shards/alabama_full --out shards/vault/alabama_full_heatmap.json
  echo \"--- Ingesting to Pi Qdrant ---\"
  python3 spectral/legal_temporal_ingest.py \
    --shards shards/alabama_full \
    --heatmap shards/vault/alabama_full_heatmap.json \
    --qdrant http://100.113.215.46:6340
  echo \"DONE\"
' > /tmp/ingest.log 2>&1 &
echo \"Ingest running. PID: \$!\"
echo \"Tail with: ssh -i ~/.ssh/vast_key -p $PORT root@$HOST tail -f /tmp/ingest.log\""
