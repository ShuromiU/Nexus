use std::fmt;
use std::collections::HashMap;

/// Maximum retry count.
pub const MAX_RETRIES: u32 = 3;

static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// A user in the system.
#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}

/// Result type alias.
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Status of an entity.
pub enum Status {
    Active,
    Inactive,
}

/// A trait for services.
pub trait Service {
    /// Initialize the service.
    fn init(&self) -> Result<()>;
}

impl User {
    /// Create a new user.
    pub fn new(id: String, name: String, email: String) -> Self {
        User { id, name, email }
    }
}

impl fmt::Display for User {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name, self.email)
    }
}

/// Greet a person by name.
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

/// Fetch data from a URL.
pub async fn fetch_data(url: &str) -> Result<Vec<u8>> {
    Ok(Vec::new())
}

fn private_helper() -> bool {
    true
}

mod internal {
    pub fn nested_public() {}
}
