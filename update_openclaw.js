const fs = require("fs");
const path = require("path");

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory() && !file.includes("node_modules") && !file.includes(".git")) {
      results = results.concat(walk(file));
    } else if (file.endsWith("package.json")) {
      results.push(file);
    }
  });
  return results;
}

const pjsons = walk("c:/dev/openclaw");
let updatedCount = 0;

for (const p of pjsons) {
  let changed = false;
  const content = fs.readFileSync(p, "utf8");
  let d;
  try {
    d = JSON.parse(content);
  } catch {
    continue;
  }

  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (d[key] && typeof d[key]["openclaw"] === "string") {
      if (d[key]["openclaw"] !== "^2026.3.2" && d[key]["openclaw"] !== "workspace:*") {
        d[key]["openclaw"] = "^2026.3.2";
        changed = true;
      }
    }
  }

  // Also handle engines if openclaw is required there, although the user just said dependency.
  // Actually, wait, let's just stick to the 3 main ones to be safe, plus maybe root openclaw?
  // Root package.json had "openclaw": "openclaw.mjs" under bin? No, that's "bin". Let's verify root package.json!

  if (changed) {
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
    console.log("Updated " + p);
    updatedCount++;
  }
}
console.log("Total files updated: " + updatedCount);
