import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.js"],
  bundle: true,
  outfile: "dist/main.js",
  format: "iife",
  target: "es2020",
  external: ["photoshop", "uxp", "fs"],
  define: {
    "process.env.NODE_ENV": '"production"'
  },
  logLevel: "info"
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching Photoshop plugin source...");
} else {
  await esbuild.build(options);
}
