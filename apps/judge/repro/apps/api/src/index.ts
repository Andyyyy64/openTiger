import express from "express";
import { db } from "@repo/db";

const app = express();
const port = process.env.API_PORT || 3001;

app.get("/", (req, res) => {
  res.send("API is running");
});

app.get("/db", (req, res) => {
  res.send(db.query());
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
