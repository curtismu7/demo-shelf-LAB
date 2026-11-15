import React from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root.jsx";
import "./standalone-ui.css";
import "./components/VerifyMark.css";
import "./styles.css";

createRoot(document.getElementById("root")).render(<Root />);
