#!/bin/bash
jq '.channels.whatsapp.allowChats = ["120363425273773444@g.us"] | .channels.whatsapp.syncFullHistory = true' ~/.openclaw/openclaw.json > /tmp/openclaw-new.json && mv /tmp/openclaw-new.json ~/.openclaw/openclaw.json && echo "Config updated successfully" && cat ~/.openclaw/openclaw.json
