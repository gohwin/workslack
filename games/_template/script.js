const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

// 여기에 게임 로직을 작성하세요.
// 예: ctx.fillRect(x, y, w, h), addEventListener("keydown", ...), requestAnimationFrame 루프 등

ctx.fillStyle = "#9a9aa6";
ctx.font = "16px sans-serif";
ctx.textAlign = "center";
ctx.fillText("여기에 게임을 만들어보세요", canvas.width / 2, canvas.height / 2);
