# consoleweb

SSH先やGUIなし環境で `https://auth.openai.com/codex/device` を使った認証を行うための最小CLIです。

## 使い方

```bash
node codex-device-auth.js
```

実行すると以下を表示します。

1. ブラウザで開くURL
2. 入力するワンタイムコード

その後、認証完了までポーリングし、取得したトークンを `./auth.json` に保存します。

## 主なオプション

```bash
node codex-device-auth.js --output ~/.config/consoleweb/auth.json
node codex-device-auth.js --poll-only
node codex-device-auth.js --json
```

`--poll-only` はコード発行までで止めたいとき用です。`--json` は他のツールから扱いやすいJSON出力に切り替えます。

## 出力

保存されるJSONには少なくとも以下が含まれます。

- `issuer`
- `client_id`
- `verification_url`
- `user_code`
- `device_auth_id`
- `created_at`
- `tokens.access_token`
- `tokens.refresh_token`
- `tokens.id_token`

`auth.json` には機密情報が含まれるため、スクリプトは `0600` 権限で保存します。
