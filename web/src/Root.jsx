import { useEffect, useState } from "react";
import App from "./App.jsx";
import VerifyPage from "./VerifyPage.jsx";

// Two pages, told apart by the address fragment so the lab-proxy and the server need no extra route: #/verify is the Verification page,
// anything else is the shelf.
const onVerify = () => window.location.hash.replace(/\/+$/, "") === "#/verify";

export default function Root() {
  const [verify, setVerify] = useState(onVerify);
  useEffect(() => {
    const sync = () => setVerify(onVerify());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return verify ? <VerifyPage /> : <App />;
}
