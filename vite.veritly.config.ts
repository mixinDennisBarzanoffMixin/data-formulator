import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import path from "node:path"

export default defineConfig({
  base: "/veritly/",
  plugins: [
    react(),
    {
      name: "veritly-workspace",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith("/veritly/workspace")) {
            request.url = request.url.replace("/veritly/workspace", "/veritly/veritly.html")
          }
          next()
        })
      },
    },
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: path.join(__dirname, "dist-veritly"),
    emptyOutDir: true,
    rollupOptions: { input: path.join(__dirname, "veritly.html") },
  },
  server: {
    host: "0.0.0.0",
    port: 5568,
    allowedHosts: ["data-web", ".veritly.co.uk", ".veritly.svc.cluster.local", "localhost"],
  },
})
