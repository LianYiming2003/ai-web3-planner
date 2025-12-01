// frontend/src/hooks/useWallet.tsx
import { useEffect, useState, useCallback } from "react";
import { ethers } from "ethers";

declare global {
  interface Window {
    ethereum?: any;
  }
}

export function useWallet() {
  const [provider, setProvider] = useState<ethers.providers.Web3Provider | null>(
    null
  );
  const [account, setAccount] = useState<string>("");
  const [error, setError] = useState<string>("");

  // 初始化：如果已经有钱包并且之前授权过，就自动拿一次账号
  useEffect(() => {
    if (!window.ethereum) {
      console.warn("No window.ethereum – install MetaMask?");
      setError("No Ethereum wallet found. Please install MetaMask.");
      return;
    }

    const p = new ethers.providers.Web3Provider(window.ethereum, "any");
    setProvider(p);

    // 如果之前授权过，listAccounts 会返回账号
    p.listAccounts()
      .then((accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          setError("");
        }
      })
      .catch((err: unknown) => {
        console.error("listAccounts error:", err);
      });

    const handleAccountsChanged = (accounts: string[]) => {
      setAccount(accounts[0] || "");
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);

    return () => {
      window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
    };
  }, []);

  // 手动连接钱包（点按钮）
  const connect = useCallback(async () => {
    console.log("connect() called");

    if (!window.ethereum) {
      setError("No Ethereum wallet found. Please install MetaMask.");
      return;
    }

    try {
      // 确保 provider 一定有
      const p =
        provider ??
        new ethers.providers.Web3Provider(window.ethereum, "any");
      if (!provider) {
        setProvider(p);
      }

      const accounts: string[] = await p.send("eth_requestAccounts", []);
      console.log("eth_requestAccounts result:", accounts);

      if (accounts.length === 0) {
        setError("No account found in wallet");
        return;
      }

      setAccount(accounts[0]);
      setError("");
    } catch (err: unknown) {
      console.error("connect() error:", err);
      const msg =
        err instanceof Error ? err.message : "Failed to connect wallet";
      setError(msg);
    }
  }, [provider]);

  return { provider, account, connect, error };
}
