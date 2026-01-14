const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK - TICO-bot vivo ✅"));

app.get("/webhook", (req, res) => {
  res.send("Webhook activo");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));


