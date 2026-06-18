#!/bin/bash
# Script to restore the Auto Sync workflow
# Run this after getting a token with the 'workflow' scope
# Usage: ./restore-sync.sh <TOKEN_WITH_WORKFLOW_SCOPE>

TOKEN=${1:-""}
if [ -z "$TOKEN" ]; then
  echo "Usage: ./restore-sync.sh <GITHUB_TOKEN_WITH_WORKFLOW_SCOPE>"
  exit 1
fi

SYNC_YML_B64=$(base64 -w0 sync-workflow-template.yml)

curl -s -X PUT \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Skailex239/TheFrontStats/contents/.github/workflows/sync.yml \
  -d "{
    \"message\": \"Restore Auto Sync workflow\",
    \"content\": \"$SYNC_YML_B64\",
    \"branch\": \"main\"
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d.get('status','created'), 'Message:', d.get('message','ok'))"

echo ""
echo "If Status: created -> sync.yml is restored!"
echo "If 403/422 -> Your token needs the 'workflow' scope"
