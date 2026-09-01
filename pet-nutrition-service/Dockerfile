FROM public.ecr.aws/eks-distro-build-tooling/nodejs:16

WORKDIR /app
COPY package*.json ./
RUN npm install --production
# OpenTelemetry auto-instrumentation (Node exports over gRPC :4317).
RUN npm install --production @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/api-logs
COPY . .

EXPOSE 3000
ENV PORT=3000

# Attach the auto-instrumentation register hook without changing the CMD.
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
CMD ["node", "server.js"]
