# Room Hockey

外部ライブラリなしの Node.js + WebSocket 製リアルタイムCanvasホッケーです。

## ローカル起動

```bash
npm start
```

ブラウザで `http://localhost:8080/` を開きます。

## 遊び方

- URLの `?room=XXXXXX` がルームIDです。
- 表示された Room URL を共有すると、別端末から同じ部屋へ参加できます。
- 人間とCPUを合わせて最大6人まで参加できます。
- ロビーのCPU欄でCPU数を選べます。
- スマホは左下の操作エリアに指を置き、置いた位置を基準にドラッグした方向へ移動します。
- 右下の `POWER` で強打準備です。
- PCは `WASD` または矢印キーで移動、SpaceでPOWERです。

## GitHubアップロード

```bash
git init
git add .
git commit -m "Add room hockey"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

## Render公開

1. Renderで `New` から `Web Service` を選びます。
2. GitHubリポジトリを接続します。
3. Environmentは `Node` を選びます。
4. Build Commandは空欄、または `npm install` のままで問題ありません。依存パッケージはありません。
5. Start Commandを `npm start` にします。
6. Deploy後に発行されたURLを開き、Room URLを共有します。

Renderは `PORT` 環境変数を自動設定します。`server.js` は `process.env.PORT` を優先して使います。
