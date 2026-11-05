export function reportProgress(completed, total, label = "") {
    if (process.env.STRAT_GUI_PROGRESS !== "1") return;
    const cleanLabel = String(label).replace(/[\r\n]+/g, " ");
    process.stdout.write(`@@progress ${completed} ${total} ${cleanLabel}\n`);
}