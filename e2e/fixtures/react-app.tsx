/** @jsxImportSource react */
import { useState } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    __bumpPrice?: () => void;
    __toggleNotice?: () => void;
    __toggleBadge?: () => void;
    __remountLead?: () => void;
  }
}

const App = () => {
  const [price, setPrice] = useState(1000);
  const [showNotice, setShowNotice] = useState(false);
  const [showBadge, setShowBadge] = useState(false);
  const [leadKey, setLeadKey] = useState(0);
  window.__bumpPrice = () => setPrice((p) => p + 100);
  window.__toggleNotice = () => setShowNotice((s) => !s);
  window.__toggleBadge = () => setShowBadge((s) => !s);
  window.__remountLead = () => setLeadKey((k) => k + 1);
  return (
    <main>
      <h1 data-testid="title">React 商品ページ</h1>
      <p data-testid="price">価格 {price} 円（税込）</p>
      <p data-testid="lead" key={leadKey}>
        送料無料でお届けします
      </p>
      <p data-testid="campaign">
        {showBadge && <strong>NEW</strong>}
        春のキャンペーン実施中
      </p>
      {showNotice && <p data-testid="notice">在庫わずか</p>}
      <button type="button" onClick={() => setPrice((p) => p + 100)}>
        値上げ
      </button>
    </main>
  );
};

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  createRoot(rootEl).render(<App />);
}
