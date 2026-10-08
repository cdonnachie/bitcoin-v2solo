// Removes the dashboard password and signs out every session; passkeys are kept. The running
// dashboard then prints a new setup code to its log the next time its login page is opened.
//   docker exec bitcoin-v2solo-dashboard node reset-password.js
const { openAuth } = require("./auth");

openAuth(process.env.DASHBOARD_AUTH_DB || "/var/lib/dashboard/auth.db", { announce: false }).resetPassword();
console.log("Password removed and all sessions signed out.");
console.log("Open the dashboard's login page, then read the new setup code from its log:");
console.log("  docker logs bitcoin-v2solo-dashboard 2>&1 | grep 'setup code' | tail -1");
