# Use Node.js 18 LTS with better compatibility
FROM node:18-alpine

# Install OpenSSL and other required dependencies
RUN apk add --no-cache openssl openssl-dev curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Run build and postbuild scripts
RUN npm run build
RUN npm run postbuild

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

# Start application with proper signal handling
CMD ["node", "index.js"]