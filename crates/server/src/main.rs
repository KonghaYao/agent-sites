use clap::Parser;

/// agent-sites — Agent 站点托管平台
#[derive(Parser, Debug)]
#[command(name = "agent-sites", version, about)]
struct Cli {
    /// 监听地址
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// 监听端口
    #[arg(long, default_value = "3000")]
    port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();
    let addr = format!("{}:{}", cli.host, cli.port);

    let app = agent_sites::create_app();

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("agent-sites 监听 http://{addr}");

    axum::serve(listener, app).await?;

    Ok(())
}
