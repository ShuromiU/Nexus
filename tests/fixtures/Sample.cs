using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Example.Sample
{
    /// <summary>
    /// Maximum retry count.
    /// </summary>
    public static class Constants
    {
        public const int MaxRetries = 3;
    }

    /// <summary>
    /// A user in the system.
    /// </summary>
    public class User
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Email { get; set; }

        public User(string id, string name, string email)
        {
            Id = id;
            Name = name;
            Email = email;
        }
    }

    /// <summary>
    /// Status of an entity.
    /// </summary>
    public enum Status
    {
        Active,
        Inactive
    }

    /// <summary>
    /// A service interface.
    /// </summary>
    public interface IService
    {
        void Init();
        User FindUser(string id);
    }

    /// <summary>
    /// Service for managing users.
    /// </summary>
    public class UserService : IService
    {
        private readonly object _db;

        public UserService(object db)
        {
            _db = db;
        }

        public void Init()
        {
            // initialization
        }

        /// <summary>
        /// Find a user by ID.
        /// </summary>
        public User FindUser(string id)
        {
            return null;
        }

        /// <summary>
        /// Greet a person.
        /// </summary>
        public static string Greet(string name)
        {
            return $"Hello, {name}!";
        }

        /// <summary>
        /// Fetch data asynchronously.
        /// </summary>
        public async Task<byte[]> FetchData(string url)
        {
            return Array.Empty<byte>();
        }

        private void PrivateHelper()
        {
            // internal
        }
    }
}
