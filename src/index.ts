import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch, { Headers } from "node-fetch";

const ESI_BASE_URL = "https://esi.evetech.net/latest";
const USER_AGENT = "eve-online-mcp/1.0 (github.com/your-username/eve-online-mcp)";

// レート制限のための変数
const rateLimits = new Map<string, { remaining: number; reset: number }>();

// Create server instance
const server = new McpServer({
  name: "eve-online-market",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

interface ESIError {
  error: string;
  sso_status?: number;
  error_description?: string;
}

// EVE Online Market APIのインターフェース
interface MarketOrder {
  duration: number;
  is_buy_order: boolean;
  issued: string;
  location_id: number;
  min_volume: number;
  order_id: number;
  price: number;
  range: string;
  system_id: number;
  type_id: number;
  volume_remain: number;
  volume_total: number;
}

interface MarketHistory {
  average: number;
  date: string;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

interface MarketGroup {
  buy: {
    volume: number;
    weighted_average: number;
    max: number;
    min: number;
    stddev: number;
    median: number;
    percentile: number;
  };
  sell: {
    volume: number;
    weighted_average: number;
    max: number;
    min: number;
    stddev: number;
    median: number;
    percentile: number;
  };
}

interface MarketPrice {
  adjusted_price?: number;
  average_price?: number;
  type_id: number;
}

interface MarketStat {
  name: string;
  value: number;
}

// 認証関連のインターフェース
interface EveAuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  issued_at: number;
}

interface EveCharacter {
  CharacterID: number;
  CharacterName: string;
  ExpiresOn: string;
  Scopes: string;
  TokenType: string;
  CharacterOwnerHash: string;
}

// 環境変数の設定
const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID || "";
const EVE_CLIENT_SECRET = process.env.EVE_CLIENT_SECRET || "";
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL || "http://localhost:3000/callback";

// SSO認証URLの生成
function generateAuthUrl(state: string): string {
  const scopes = [
    "esi-markets.structure_markets.v1",
    "esi-markets.read_character_orders.v1"
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: EVE_CALLBACK_URL,
    client_id: EVE_CLIENT_ID,
    scope: scopes,
    state: state
  });

  return `https://login.eveonline.com/v2/oauth/authorize?${params.toString()}`;
}

// トークンの取得
async function getToken(code: string): Promise<EveAuthToken> {
  const response = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString("base64")}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code
    })
  });

  if (!response.ok) {
    throw new Error("Failed to get token");
  }

  const data = await response.json() as EveAuthToken;
  return {
    ...data,
    issued_at: Date.now()
  };
}

// トークンの更新
async function refreshToken(refresh_token: string): Promise<EveAuthToken> {
  const response = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString("base64")}`
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh_token
    })
  });

  if (!response.ok) {
    throw new Error("Failed to refresh token");
  }

  const data = await response.json() as EveAuthToken;
  return {
    ...data,
    issued_at: Date.now()
  };
}

// キャラクター情報の取得
async function verifyToken(token: string): Promise<EveCharacter> {
  const response = await fetch("https://login.eveonline.com/oauth/verify", {
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error("Failed to verify token");
  }

  return response.json() as Promise<EveCharacter>;
}

// トークンの有効性チェック
function isTokenExpired(token: EveAuthToken): boolean {
  const expiryTime = token.issued_at + (token.expires_in * 1000);
  return Date.now() >= expiryTime;
}

// レート制限をチェックする関数
function checkRateLimit(endpoint: string): boolean {
  const limit = rateLimits.get(endpoint);
  if (!limit) return true;

  if (Date.now() > limit.reset) {
    rateLimits.delete(endpoint);
    return true;
  }

  return limit.remaining > 0;
}

// レート制限を更新する関数
function updateRateLimit(endpoint: string, headers: Headers) {
  const remaining = parseInt(headers.get("x-esi-error-limit-remain") || "100");
  const resetSeconds = parseInt(headers.get("x-esi-error-limit-reset") || "60");
  
  rateLimits.set(endpoint, {
    remaining,
    reset: Date.now() + (resetSeconds * 1000)
  });
}

// Helper function for making ESI API requests
async function makeESIRequest<T>(endpoint: string, token?: string): Promise<T> {
  if (!checkRateLimit(endpoint)) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${ESI_BASE_URL}${endpoint}`, { headers });
  updateRateLimit(endpoint, response.headers);

  if (!response.ok) {
    let errorMessage = `HTTP error! status: ${response.status}`;
    try {
      const errorData = await response.json() as ESIError;
      if (errorData.error) {
        errorMessage = `ESI Error: ${errorData.error}`;
        if (errorData.error_description) {
          errorMessage += ` - ${errorData.error_description}`;
        }
      }
    } catch {
      // エラーJSONのパースに失敗した場合は、デフォルトのエラーメッセージを使用
    }
    throw new Error(errorMessage);
  }

  return response.json() as Promise<T>;
}

// Register market tools
server.tool(
  "get-market-prices",
  "Get market prices for all items in EVE Online",
  {},
  async () => {
    const prices = await makeESIRequest<Array<{
      type_id: number;
      adjusted_price?: number;
      average_price?: number;
    }>>("/markets/prices/");

    const formattedPrices = prices.map((price) => ({
      type_id: price.type_id,
      adjusted_price: price.adjusted_price || 0,
      average_price: price.average_price || 0,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formattedPrices, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-market-orders",
  "Get market orders from a specific region",
  {
    region_id: z.number().describe("Region ID to get market orders from"),
    type_id: z.number().optional().describe("Item type ID to filter orders"),
    order_type: z
      .enum(["buy", "sell", "all"])
      .default("all")
      .describe("Type of orders to retrieve"),
  },
  async ({ region_id, type_id, order_type }) => {
    let endpoint = `/markets/${region_id}/orders/`;
    if (type_id) {
      endpoint += `?type_id=${type_id}`;
    }

    const orders = await makeESIRequest<Array<MarketOrder>>(endpoint);

    const filteredOrders = orders.filter((order) => {
      if (order_type === "buy") return order.is_buy_order;
      if (order_type === "sell") return !order.is_buy_order;
      return true;
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(filteredOrders, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-market-history",
  "Get market history for a specific item in a region",
  {
    region_id: z.number().describe("Region ID to get market history from"),
    type_id: z.number().describe("Item type ID to get history for"),
  },
  async ({ region_id, type_id }) => {
    const history = await makeESIRequest<Array<MarketHistory>>(`/markets/${region_id}/history/?type_id=${type_id}`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(history, null, 2),
        },
      ],
    };
  }
);

// グループ化された市場注文を取得
server.tool(
  "get-market-groups",
  "Get grouped market data for a region and type",
  {
    region_id: z.number().describe("Region ID to get market groups from"),
    type_id: z.number().describe("Item type ID to get groups for"),
  },
  async ({ region_id, type_id }) => {
    const groups = await makeESIRequest<MarketGroup>(
      `/markets/${region_id}/types/${type_id}/`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            buy: {
              volume: groups.buy.volume,
              weighted_average: groups.buy.weighted_average,
              max: groups.buy.max,
              min: groups.buy.min,
              median: groups.buy.median
            },
            sell: {
              volume: groups.sell.volume,
              weighted_average: groups.sell.weighted_average,
              max: groups.sell.max,
              min: groups.sell.min,
              median: groups.sell.median
            }
          }, null, 2)
        }
      ]
    };
  }
);

// 構造体の市場注文を取得
server.tool(
  "get-structure-orders",
  "Get all market orders in a structure",
  {
    structure_id: z.number().describe("Structure ID to get market orders from"),
    page: z.number().optional().describe("Which page to query, starts at 1"),
  },
  async ({ structure_id, page }) => {
    const endpoint = `/markets/structures/${structure_id}/${page ? `?page=${page}` : ''}`;
    const orders = await makeESIRequest<MarketOrder[]>(endpoint);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(orders.map(order => ({
            order_id: order.order_id,
            type_id: order.type_id,
            price: order.price,
            volume_remain: order.volume_remain,
            volume_total: order.volume_total,
            is_buy_order: order.is_buy_order,
            duration: order.duration,
            issued: order.issued,
            range: order.range
          })), null, 2)
        }
      ]
    };
  }
);

// 地域の取引所統計を取得
server.tool(
  "get-market-stats",
  "Get market statistics for a region",
  {
    region_id: z.number().describe("Region ID to get statistics from"),
  },
  async ({ region_id }) => {
    const stats = await makeESIRequest<MarketStat[]>(
      `/markets/${region_id}/stats/`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(stats, null, 2)
        }
      ]
    };
  }
);

// 特定のタイプIDのアイテムの構造体市場の全注文を取得
server.tool(
  "get-structure-type-orders",
  "Get all market orders for a specific type in a structure",
  {
    structure_id: z.number().describe("Structure ID to get market orders from"),
    type_id: z.number().describe("Item type ID to get orders for"),
    page: z.number().optional().describe("Which page to query, starts at 1"),
  },
  async ({ structure_id, type_id, page }) => {
    const endpoint = `/markets/structures/${structure_id}/types/${type_id}/${page ? `?page=${page}` : ''}`;
    const orders = await makeESIRequest<MarketOrder[]>(endpoint);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(orders.map(order => ({
            order_id: order.order_id,
            price: order.price,
            volume_remain: order.volume_remain,
            volume_total: order.volume_total,
            is_buy_order: order.is_buy_order,
            duration: order.duration,
            issued: order.issued,
            range: order.range
          })), null, 2)
        }
      ]
    };
  }
);

// 認証関連のツール
server.tool(
  "get-auth-url",
  "Get the authentication URL for EVE Online SSO",
  {
    state: z.string().describe("State parameter for OAuth2 flow")
  },
  async ({ state }) => {
    const authUrl = generateAuthUrl(state);
    return {
      content: [
        {
          type: "text",
          text: authUrl
        }
      ]
    };
  }
);

server.tool(
  "authenticate",
  "Exchange authorization code for access token",
  {
    code: z.string().describe("Authorization code from EVE Online SSO")
  },
  async ({ code }) => {
    try {
      const token = await getToken(code);
      const character = await verifyToken(token.access_token);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              character_name: character.CharacterName,
              character_id: character.CharacterID,
              access_token: token.access_token,
              refresh_token: token.refresh_token,
              expires_in: token.expires_in,
              token_type: token.token_type
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }
);

server.tool(
  "refresh-token",
  "Refresh an expired access token",
  {
    refresh_token: z.string().describe("Refresh token from previous authentication")
  },
  async ({ refresh_token }) => {
    try {
      const token = await refreshToken(refresh_token);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              access_token: token.access_token,
              refresh_token: token.refresh_token,
              expires_in: token.expires_in,
              token_type: token.token_type
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("EVE Online Market MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
