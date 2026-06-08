/**
 * Admin script pour générer des codes récompense TheFrontStats.
 * 
 * Usage :
 *   node generate-code.js              → Génère 1 code VIP
 *   node generate-code.js 5            → Génère 5 codes VIP
 *   node generate-code.js 3 vip        → Génère 3 codes VIP
 *   node generate-code.js 2 gold       → Génère 2 codes GOLD
 * 
 * Les codes sont ajoutés directement dans Firestore (collection reward-codes).
 */

import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, collection, getDocs } from "firebase/firestore";
import { firebaseConfig } from "./shared/firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Pas de I,O,0,1 pour éviter la confusion
  let code = "OR-"; // OR = FrontTracker
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function main() {
  const count = parseInt(process.argv[2] || "1", 10);
  const type = process.argv[3] || "vip";

  console.log(`\n🎁 Génération de ${count} code(s) "${type}"...\n`);

  for (let i = 0; i < count; i++) {
    const code = generateCode();
    const id = `code_${Date.now()}_${i}`;

    try {
      await setDoc(doc(db, "reward-codes", id), {
        code,
        type,
        used: false,
        usedBy: null,
        usedAt: null,
        createdAt: new Date().toISOString(),
      });
      console.log(`  ✅ ${code} (${type})`);
    } catch (e) {
      console.error(`  ❌ Erreur pour ${code}:`, e.message);
    }
  }

  console.log(`\n✨ ${count} code(s) généré(s) avec succès !\n`);

  // Afficher les codes existants non utilisés
  const snap = await getDocs(collection(db, "reward-codes"));
  const unused = [];
  snap.forEach((d) => {
    const data = d.data();
    if (!data.used) unused.push(data);
  });
  console.log(`📋 Codes non utilisés restants : ${unused.length}`);
  unused.forEach((c) => console.log(`   ${c.code} (${c.type})`));
  console.log();

  process.exit(0);
}

main().catch((e) => {
  console.error("Erreur:", e);
  process.exit(1);
});
