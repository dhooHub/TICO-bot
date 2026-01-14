const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK - TICO-bot vivo ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));
app.get("/webhook", (req, res) => {
  res.send("Webhook activo");
});

