# consoleweb

SSH先やGUIなし環境で、`codex` CLI が表示した device auth のワンタイムコードを使ってトークン取得を待ち受ける最小CLIです。

## 使い方

```bash
node codex-device-auth.js --user-code ABCD-EFGH
```

想定フローは以下です。

1. `codex` コマンドを実行する
2. 認証方法として device auth を選ぶ
3. `codex` 側に表示されたワンタイムコードを控える
4. この CLI に `--user-code` で渡して待機する
5. 別の端末やブラウザ側で認証を完了する

このスクリプト自身はワンタイムコードを発行しません。認証完了までポーリングし、取得したトークンを `./auth.json` に保存します。

## 主なオプション

```bash
node codex-device-auth.js --user-code ABCD-EFGH --output ~/.config/consoleweb/auth.json
node codex-device-auth.js --user-code ABCD-EFGH --interval-seconds 3
node codex-device-auth.js --user-code ABCD-EFGH --max-attempts 20
node codex-device-auth.js --user-code ABCD-EFGH --device-auth-id your-device-auth-id
node codex-device-auth.js --json
```

- `--user-code` は必須です
- `--device-auth-id` は取得できている場合だけ渡します
- `--max-attempts` はポーリング回数の上限です。既定値は 10 回です
- `--json` は他のツールから扱いやすいJSON出力に切り替えます

## 出力

保存されるJSONには少なくとも以下が含まれます。

- `issuer`
- `client_id`
- `verification_url`
- `user_code`
- `created_at`
- `tokens.access_token`
- `tokens.refresh_token`
- `tokens.id_token`

`device_auth_id` を引数で渡した場合は、その値も保存されます。

`auth.json` には機密情報が含まれるため、スクリプトは `0600` 権限で保存します。
