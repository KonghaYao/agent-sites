pub fn create_app() -> axum::Router {
    use axum::routing::get;

    axum::Router::new()
        .route("/", get(root_handler))
        .route("/health", get(health_handler))
}

async fn root_handler() -> &'static str {
    "agent-sites — Agent 站点托管平台"
}

async fn health_handler() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_app_不panic() {
        let _app = create_app();
    }
}
